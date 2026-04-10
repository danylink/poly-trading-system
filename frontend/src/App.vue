<script setup>
import { ref, onMounted, computed, onUnmounted } from 'vue'
import axios from 'axios'
import { 
  Activity, ShieldCheck, Target, Cpu, Bot, Clock3, Power, ArrowUpRight, Lock, LifeBuoy
} from 'lucide-vue-next'
import Swal from 'sweetalert2';

// Antes: const API_URL = 'http://localhost:3001/api';
// Ahora: Dinámico según el entorno
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// --- ESTADO REACTIVO UNIFICADO ---
const status = ref({
  lastCheck: null,
  lastProbability: 0,
  currentMarket: { title: 'Cargando radar...' },
  lastNews: [],
  balanceUSDC: '0.00',
  balancePOL: '0.00',
  executions: [],
  pendingSignals: [],
  autoTradeEnabled: true,
  microBetAmount: 1.00,
  predictionThreshold: 0.70,
  edgeThreshold: 0.09,
  takeProfitThreshold: 18,
  marketFilters: { crypto: true, politics: true, business: true, sports: false, pop: false },
  copyTradingEnabled: false,
    maxCopySize: 50,
    maxCopyPercentOfBalance: 8,
    autoSelectedWhales: [],
    copiedTrades: []
})

// Arreglo maestro para forzar el orden visual de los filtros
const filterOrder = ['crypto', 'politics', 'business', 'sports', 'pop'];

// --- 🔒 SISTEMA DE LOGIN PREMIUM ---
const isAuthenticated = ref(!!localStorage.getItem('poly_auth'));
const authPassword = ref('');

// Escudo: Si el backend nos expulsa (401), cerramos la sesión automáticamente
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response && error.response.status === 401) {
      isAuthenticated.value = false;
      localStorage.removeItem('poly_auth');
    }
    return Promise.reject(error);
  }
);

// Si ya ingresamos la clave antes, la pre-cargamos
if (isAuthenticated.value) {
  axios.defaults.headers.common['Authorization'] = localStorage.getItem('poly_auth');
}

const attemptLogin = async () => {
  try {
    const res = await axios.get(`${API_URL}/status`, {
      headers: { 'Authorization': authPassword.value }
    });
    // Si la clave es correcta, el backend responderá con los datos
    localStorage.setItem('poly_auth', authPassword.value);
    axios.defaults.headers.common['Authorization'] = authPassword.value;
    isAuthenticated.value = true;
    Object.assign(status.value, res.data); // Cargamos el dashboard
  } catch (error) {
    Swal.fire({ title: 'Acceso Denegado', text: 'Clave incorrecta', icon: 'error', background: '#1c1917', color: '#ef4444' });
    authPassword.value = '';
  }
};

const logout = () => {
  localStorage.removeItem('poly_auth');
  delete axios.defaults.headers.common['Authorization'];
  isAuthenticated.value = false;
};

const isAutoTradeUpdating = ref(false);
const isThresholdUpdating = ref(false);
let pollingInterval = null;
const isSelling = ref({});

// --- FUNCIONES DE COMUNICACIÓN CON EL BACKEND ---

const fetchStatus = async () => {
  try {
    const res = await axios.get(`${API_URL}/status`);
    // Mantenemos la referencia del objeto para no perder reactividad
    Object.assign(status.value, res.data);
  } catch (e) { 
    console.error("📡 Error: Backend desconectado"); 
  }
}

const updateAutoTrade = async () => {
  isAutoTradeUpdating.value = true;
  try {
    await axios.post(`${API_URL}/settings/autotrade`, {
      enabled: status.value.autoTradeEnabled,
      amount: status.value.microBetAmount
    });
  } catch (error) {
    console.error("❌ Error actualizando AutoTrade");
  } finally {
    isAutoTradeUpdating.value = false;
  }
};

const updateThreshold = async () => {
  isThresholdUpdating.value = true;
  try {
    await axios.post(`${API_URL}/settings/threshold`, {
      threshold: parseFloat(status.value.predictionThreshold)
    });
  } catch (error) {
    console.error("❌ Error sincronizando Umbral");
  } finally {
    isThresholdUpdating.value = false;
  }
};

const executeManualTrade = async (signal) => {
  if (signal.loading) return;
  signal.loading = true;
  
  try {
    const res = await axios.post(`${API_URL}/execute-trade`, {
      market: signal.marketName,
      amount: status.value.microBetAmount,
      conditionId: signal.conditionId,
      tokenId: signal.tokenId,
      // 🚨 AGREGAMOS EL PRECIO AQUÍ PARA EL BACKEND
      marketPrice: signal.marketPrice 
    });
    
    if (res.data.success) {
      // Limpiar señal localmente tras éxito
      status.value.pendingSignals = status.value.pendingSignals.filter(s => s.id !== signal.id);
      await fetchStatus(); 
    }
  } catch (error) {
    console.error("❌ Fallo en ejecución manual", error);
  } finally {
    signal.loading = false;
  }
};

const rejectSignal = (id) => {
  status.value.pendingSignals = status.value.pendingSignals.filter(s => s.id !== id);
};

const setThreshold = (val) => {
  status.value.predictionThreshold = val;
  updateThreshold();
};

const sellPosition = async (tokenId, exactSize) => {
  // 1. Alerta de Confirmación
  const result = await Swal.fire({
    title: '¿Confirmar Disparo?',
    text: `Estás a punto de vender ${exactSize} acciones. Esta acción no se puede deshacer.`,
    icon: 'warning',
    background: '#1C1612', // Fondo café oscuro
    color: '#e4e4e7', // Texto claro (zinc-200)
    iconColor: '#D4AF37', // Ícono dorado
    showCancelButton: true,
    confirmButtonColor: '#D4AF37', // Botón dorado
    cancelButtonColor: '#3f3f46', // Botón cancelar gris
    confirmButtonText: '<span style="color: #3C2A21; font-weight: 900;">VENDER AHORA</span>',
    cancelButtonText: 'CANCELAR',
    customClass: {
      popup: 'border border-[#D4AF37]/30 rounded-2xl'
    }
  });

  // Si el usuario cancela, salimos de la función
  if (!result.isConfirmed) return;

  // Empezamos a cargar
  isSelling.value[tokenId] = true;

  try {
    const response = await fetch(`${API_URL}/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId, shares: exactSize })
    });

    const data = await response.json();

    if (data.success) {
      // 2. Alerta de Éxito
      Swal.fire({
        title: '¡Venta Ejecutada!',
        text: 'La posición ha sido cerrada con éxito en la blockchain.',
        icon: 'success',
        background: '#1C1612',
        color: '#e4e4e7',
        iconColor: '#10b981', // Verde esmeralda de tu diseño
        confirmButtonColor: '#10b981',
        confirmButtonText: 'EXCELENTE',
        customClass: {
          popup: 'border border-[#10b981]/30 rounded-2xl'
        }
      });
      // Aquí puedes llamar a tu función para recargar el dashboard
      // updateDashboardData(); 
    } else {
      // 3. Alerta de Error (controlado por la API)
      Swal.fire({
        title: 'Disparo Fallido',
        text: data.error || 'No se pudo completar la venta.',
        icon: 'error',
        background: '#1C1612',
        color: '#e4e4e7',
        iconColor: '#f43f5e', // Rojo rosa de tu diseño
        confirmButtonColor: '#f43f5e',
        confirmButtonText: 'ENTENDIDO',
        customClass: {
          popup: 'border border-[#f43f5e]/30 rounded-2xl'
        }
      });
    }
  } catch (error) {
    // Alerta de Error (Caída de red o servidor)
    Swal.fire({
      title: 'Error de Conexión',
      text: 'El servidor no responde. Revisa los logs en Toronto.',
      icon: 'error',
      background: '#1C1612',
      color: '#e4e4e7',
      iconColor: '#f43f5e',
      confirmButtonColor: '#f43f5e',
      confirmButtonText: 'CERRAR',
      customClass: {
        popup: 'border border-[#f43f5e]/30 rounded-2xl'
      }
    });
  } finally {
    isSelling.value[tokenId] = false;
  }
};

// --- 🛟 BOTÓN DE RESCATE DE FONDOS ---
const triggerRescue = async () => {
  try {
    // Como pusimos el endpoint fuera de '/api', le quitamos esa parte a la URL base
    const baseUrl = API_URL.replace('/api', '');
    
    // Mostramos estado de carga
    Swal.fire({
      title: 'Rescatando fondos...',
      text: 'Cancelando órdenes colgadas en Polymarket.',
      background: '#1c1917',
      color: '#D4AF37',
      didOpen: () => { Swal.showLoading(); }
    });

    const res = await axios.get(`${baseUrl}/rescate`);
    
    // Mostramos el mensaje de éxito del backend
    Swal.fire({
      title: '¡Operación Exitosa!',
      text: res.data,
      icon: 'success',
      background: '#1c1917',
      color: '#10B981', // Emerald
      confirmButtonColor: '#D4AF37'
    });
    
    fetchStatus(); // Refrescamos los números del dashboard al instante
  } catch (error) {
    console.error("Error en rescate:", error);
    Swal.fire({
      title: 'Error de Rescate',
      text: 'No se pudo contactar al servidor para el rescate.',
      icon: 'error',
      background: '#1c1917',
      color: '#EF4444'
    });
  }
};

// --- NUEVO CONTROL DE TAKE PROFIT ---
const updateTakeProfit = async () => {
  try {
    await axios.post(`${API_URL}/settings/autotrade`, { 
      takeProfitThreshold: status.value.takeProfitThreshold 
    });
  } catch (error) {
    console.error("Error al actualizar Take Profit:", error);
  }
};

const setTakeProfit = (val) => {
  status.value.takeProfitThreshold = val;
  updateTakeProfit();
};

// --- NUEVO CONTROL DE EDGE ---
const updateEdge = async () => {
  try {
    await axios.post(`${API_URL}/settings/autotrade`, { 
      edgeThreshold: status.value.edgeThreshold 
    });
  } catch (error) {
    console.error("Error al actualizar Edge:", error);
  }
};

const setEdge = (val) => {
  status.value.edgeThreshold = val;
  updateEdge();
};

const updateCopyTrading = async () => {
  try {
    await axios.post(`${API_URL}/settings/copytrading`, {
      enabled: status.value.copyTradingEnabled,
      maxCopySize: status.value.maxCopySize,
      maxCopyPercent: status.value.maxCopyPercentOfBalance,
      maxWhalesToCopy: status.value.maxWhalesToCopy
    });
  } catch (error) {
    console.error("Error actualizando Copy Trading settings", error);
  }
};

const updateFilters = async () => {
  try {
    await axios.post(`${API_URL}/settings/filters`, status.value.marketFilters);
  } catch (error) {
    console.error("Error actualizando filtros", error);
  }
};

// --- SISTEMA DE TERMINAL ---
const systemLogs = ref([]);

const fetchLogs = async () => {
  try {
    const res = await axios.get(`${API_URL}/logs`);
    // Invertimos el arreglo para que los mensajes más nuevos salgan arriba
    systemLogs.value = res.data.reverse(); 
  } catch (error) {
    console.error("Error al obtener logs de la terminal");
  }
};

// --- COMPUTED PROPERTIES ---

// 1. Valor total de las posiciones que siguen vivas
const activePortfolioValue = computed(() => {
  if (!status.value.activePositions) return 0;
  return status.value.activePositions.reduce((acc, pos) => {
    // Sumamos solo las que no están en fase de "CANJEAR"
    return !pos.status.includes('CANJEAR') ? acc + parseFloat(pos.currentValue || 0) : acc;
  }, 0);
});

// 2. Cartera Total (Efectivo libre + Valor de posiciones activas)
const totalCartera = computed(() => {
  const cash = parseFloat(status.value.clobOnlyUSDC || status.value.balanceUSDC || 0);
  return (cash + activePortfolioValue.value).toFixed(2);
});

// 3. Beneficio/Pérdida Flotante (Suma del PnL de todas tus posiciones abiertas)
const floatingPnL = computed(() => {
  if (!status.value.activePositions) return 0;
  return status.value.activePositions.reduce((acc, pos) => {
     return !pos.status.includes('CANJEAR') ? acc + parseFloat(pos.cashPnl || 0) : acc;
  }, 0);
});

const floatingPnLPct = computed(() => {
  const pnl = floatingPnL.value;
  // Inversión original = Valor actual - Ganancia
  const invested = activePortfolioValue.value - pnl;
  if (invested <= 0) return "0.00";
  return ((pnl / invested) * 100).toFixed(2);
});

const probColor = computed(() => {
  const p = status.value.lastProbability;
  if (p >= 0.80) return 'text-[#D4AF37] drop-shadow-[0_0_10px_rgba(212,175,55,0.4)] font-black';
  if (p >= 0.60) return 'text-amber-500/80 font-bold';
  return 'text-zinc-500';
});

// --- CICLO DE VIDA ---

onMounted(() => {
  // 1. Carga inicial al abrir la app
  fetchStatus();
  fetchLogs(); 

  // 2. Polling de 3 segundos para TODO (Balance, Señales y Terminal en vivo)
  pollingInterval = setInterval(() => {
    fetchStatus();
    fetchLogs(); // <--- NUEVO: La terminal ahora tiene vida propia
  }, 3000);
});

onUnmounted(() => {
  if (pollingInterval) clearInterval(pollingInterval);
});
</script>

<template>
  <div v-if="!isAuthenticated" class="min-h-screen bg-[#09090b] flex flex-col items-center justify-center p-4 relative overflow-hidden selection:bg-[#D4AF37]/20">
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#D4AF37]/5 via-[#09090b] to-[#09090b]"></div>
    
    <div class="relative z-10 w-full max-w-md bg-[#111114] border border-zinc-800 p-10 rounded-[2rem] shadow-2xl backdrop-blur-sm">
      <div class="flex justify-center mb-6">
        <div class="p-5 bg-[#1c1917] border border-[#D4AF37]/30 rounded-2xl shadow-[0_0_30px_rgba(212,175,55,0.1)]">
          <Lock :size="48" class="text-[#D4AF37]" />
        </div>
      </div>
      
      <h2 class="text-3xl font-black text-center text-white mb-2 tracking-tighter">Poly<span class="text-[#D4AF37]">Sniper</span></h2>
      <p class="text-zinc-500 text-xs text-center uppercase tracking-[0.2em] font-bold mb-10">Bóveda de Trading Privada</p>
      
      <form @submit.prevent="attemptLogin" class="space-y-6">
        <div>
          <label class="block text-[10px] uppercase font-black text-zinc-500 tracking-widest mb-3 text-center">Clave de Acceso</label>
          <input 
            type="password" 
            v-model="authPassword" 
            class="w-full bg-[#09090b] border-2 border-zinc-800 text-[#D4AF37] font-mono text-center text-2xl rounded-2xl p-4 focus:outline-none focus:border-[#D4AF37]/50 transition-all shadow-inner"
            placeholder="••••••••"
          />
        </div>
        
        <button type="submit" class="w-full bg-[#D4AF37] text-[#3C2A21] font-black tracking-[0.3em] uppercase py-5 rounded-2xl hover:bg-amber-400 transition-all shadow-[0_0_20px_rgba(212,175,55,0.2)] hover:scale-[1.02] active:scale-95">
          Desbloquear
        </button>
      </form>
    </div>
  </div>
  <div v-else class="min-h-screen bg-[#09090b] text-zinc-300 font-sans p-4 md:p-8 selection:bg-emerald-500/20 selection:text-emerald-300">

    <header class="max-w-[1600px] mx-auto flex flex-col sm:flex-row sm:items-center justify-between mb-10 gap-4 border-b border-zinc-800 pb-8">
      <div class="flex items-center gap-3">
        <div class="p-3 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl">
          <Bot :size="32" class="text-emerald-500" />
        </div>
        <div>
          <h1 class="text-3xl font-extrabold tracking-tighter text-white">Poly<span class="text-emerald-500">Bot</span> Terminal</h1>
          <div class="flex items-center gap-2 text-zinc-500 text-sm">
            <Activity :size="14" class="text-emerald-600" /> 
            Polygon Mainnet <span class="text-zinc-700">|</span> 
            <Clock3 :size="14"/> {{ status.lastCheck || 'Conectando...' }}
          </div>
        </div>
      </div>
      
      <div class="flex items-center gap-3 bg-zinc-900/50 p-2 rounded-full border border-zinc-800 shadow-inner">
        
        <button @click="triggerRescue" class="flex items-center gap-2.5 bg-amber-950/40 text-amber-500 px-5 py-3 rounded-full text-sm font-bold hover:bg-amber-900/60 transition active:scale-95 border border-amber-500/20 group">
          <LifeBuoy :size="18" class="text-amber-500 group-hover:rotate-180 transition-transform duration-500" />
          RESCATAR USDC
        </button>

        <button @click="triggerPanicStop" class="flex items-center gap-2.5 bg-red-950 text-red-300 px-5 py-3 rounded-full text-sm font-bold hover:bg-red-900 transition active:scale-95 group">
          <Power :size="18" class="text-red-500 group-hover:animate-pulse" />
          EMERGENCY STOP
        </button>

        <button @click="logout" class="flex items-center justify-center bg-zinc-950 border border-zinc-800 text-zinc-500 p-3 rounded-full hover:text-white hover:border-zinc-600 transition-all">
          <Lock :size="18" />
        </button>

      </div>
    </header>

    <main class="max-w-[1600px] mx-auto grid grid-cols-12 gap-8">
      
      <div class="col-span-12 xl:col-span-8 space-y-8">
        
<div class="grid grid-cols-1 md:grid-cols-3 gap-5"> 
          
          <div class="bg-[#1c1917] border-2 border-[#D4AF37] p-5 rounded-3xl shadow-[0_0_20px_rgba(212,175,55,0.2)] relative overflow-hidden group flex flex-col justify-center">
            <div class="absolute -right-6 -top-6 opacity-10"><Target :size="80" class="text-[#D4AF37]" /></div>
            <p class="text-[10px] uppercase font-black text-[#D4AF37] tracking-widest mb-1">Cartera</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-4xl font-extrabold text-white font-mono">${{ totalCartera }}</h3>
            </div>
            <p class="text-[9px] text-zinc-400 mt-2 font-bold uppercase tracking-tighter flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-[#D4AF37] animate-pulse"></span> Valor total de la cuenta
            </p>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl flex flex-col justify-center hover:border-zinc-700 transition-all">
            <p class="text-[10px] uppercase font-black text-zinc-500 tracking-widest mb-1">Disponible para operar</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-3xl font-bold text-zinc-200 font-mono">${{ status.clobOnlyUSDC || status.balanceUSDC }}</h3>
              <span class="text-[10px] text-zinc-600 font-bold">USDC</span>
            </div>
            <p class="text-[9px] text-zinc-500 mt-2 font-bold uppercase tracking-tighter">
              Efectivo libre en Polymarket
            </p>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl relative overflow-hidden flex flex-col justify-center">
            <p class="text-[10px] uppercase font-black tracking-widest mb-1 flex items-center gap-1"
               :class="floatingPnL >= 0 ? 'text-emerald-500/70' : 'text-rose-500/70'">
               <Activity :size="12" /> Beneficio / Pérdida
            </p>
            <div class="flex items-baseline gap-2">
              <h3 class="text-3xl font-bold font-mono" :class="floatingPnL >= 0 ? 'text-emerald-500' : 'text-rose-500'">
                {{ floatingPnL >= 0 ? '+' : '-' }}${{ Math.abs(floatingPnL).toFixed(2) }}
              </h3>
              <span class="text-xs font-bold font-mono" :class="floatingPnL >= 0 ? 'text-emerald-500/80' : 'text-rose-500/80'">
                ({{ floatingPnL >= 0 ? '+' : '' }}{{ floatingPnLPct }}%)
              </span>
            </div>
            
            <div class="absolute bottom-0 left-0 w-full h-1" 
                 :class="floatingPnL >= 0 ? 'bg-gradient-to-r from-emerald-900 to-emerald-500' : 'bg-gradient-to-r from-rose-900 to-rose-500'">
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl hover:border-blue-900/50 transition-all flex flex-col justify-center">
            <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">MetaMask Wallet</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-2xl font-bold text-zinc-200 font-mono">${{ status.walletOnlyUSDC }}</h3>
              <span class="text-[10px] text-zinc-600 font-bold">USDC</span>
            </div>
            <div class="mt-2 flex items-center gap-1 text-[8px] text-blue-500/70 font-bold uppercase">
              <ArrowUpRight :size="10" /> Fondos en reserva
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl flex flex-col justify-center">
            <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">Gas Network</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-2xl font-bold text-zinc-200 font-mono">{{ status.balancePOL }}</h3>
              <span class="text-[10px] text-zinc-600 font-bold">POL</span>
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl flex flex-col justify-center">
            <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">IA Confidence</p>
            <h3 class="text-2xl font-bold font-mono" :class="probColor">{{ (status.lastProbability * 100).toFixed(1) }}%</h3>
          </div>

        </div>

        <div class="mt-8 mb-6">
          <h2 class="text-[#D4AF37] font-black tracking-widest text-xs mb-4 flex items-center gap-2">
            <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
            POSICIONES EN VIVO
          </h2>
          
          <div class="grid grid-cols-1 gap-4">
            <div v-for="pos in status.activePositions" :key="pos.tokenId" 
                 class="bg-[#1c1917] border border-[#D4AF37]/40 rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center shadow-[0_0_15px_rgba(212,175,55,0.1)] hover:border-[#D4AF37]/80 transition-all">
              
              <div class="flex flex-col mb-4 md:mb-0 w-full md:w-1/2">
                <span class="text-[10px] text-zinc-500 font-bold uppercase tracking-tighter mb-1">Mercado</span>
                <span class="text-zinc-200 font-bold text-sm line-clamp-1" :title="pos.marketName">{{ pos.marketName }}</span>
                <span class="text-[#D4AF37] font-mono text-[10px] mt-1">{{ pos.size }} Acciones</span>
              </div>

              <div class="flex items-center gap-6 w-full md:w-auto justify-between md:justify-end">
                <div class="text-left md:text-right hidden sm:block">
                  <span class="text-[10px] text-zinc-500 block uppercase font-bold mb-0.5">Estado</span>
                  <span class="font-mono font-bold text-[10px]" :class="pos.status.includes('CANJEAR') ? 'text-zinc-500' : 'text-emerald-400'">
                    {{ pos.status }}
                  </span>
                </div>

                <div class="text-left md:text-right flex flex-col justify-center">
                  <span class="text-[10px] text-zinc-500 block uppercase font-bold mb-0.5">Valor</span>
                  <span class="text-white font-mono font-bold text-sm">
                    ${{ pos.currentValue }}
                  </span>
                  <span v-if="!pos.status.includes('CANJEAR')" 
                        class="text-[10px] font-bold font-mono mt-0.5 tracking-tighter"
                        :class="(pos.cashPnl || 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'">
                    {{ (pos.cashPnl || 0) >= 0 ? '+' : '' }}${{ pos.cashPnl !== undefined ? pos.cashPnl.toFixed(2) : '0.00' }} ({{ pos.percentPnl !== undefined ? pos.percentPnl.toFixed(2) : '0.00' }}%)
                  </span>
                  <span v-else class="text-[10px] font-bold font-mono mt-0.5 tracking-tighter text-rose-500">
                    -$0.00 (100%)
                  </span>
                </div>
                
                <button @click="sellPosition(pos.tokenId, pos.exactSize)" 
                        :disabled="isSelling[pos.tokenId]"
                        translate="no"
                        class="px-5 py-2.5 rounded-xl text-[10px] font-black transition-all flex items-center gap-2 disabled:opacity-50 border"
                        :class="pos.status.includes('CANJEAR') 
                          ? 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 hover:text-white' 
                          : ((pos.cashPnl || 0) >= 0 
                              ? 'bg-emerald-500/10 hover:bg-emerald-500 text-emerald-500 hover:text-white border-emerald-500/30' 
                              : 'bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white border-rose-500/30')">
                  
                  <span v-if="isSelling[pos.tokenId]" class="w-2 h-2 rounded-full animate-ping" 
                        :class="pos.status.includes('CANJEAR') ? 'bg-zinc-400' : ((pos.cashPnl || 0) >= 0 ? 'bg-emerald-400' : 'bg-rose-400')"></span>
                  
                  {{ isSelling[pos.tokenId] ? 'PROCESANDO...' : (pos.status.includes('CANJEAR') ? 'CANJEAR' : 'VENDER TODO') }}
                </button>
              </div>
            </div>

            <div v-if="!status.activePositions || status.activePositions.length === 0" 
                 class="bg-[#1c1917]/50 border border-zinc-800 border-dashed rounded-2xl p-8 text-center flex flex-col items-center justify-center">
                 <Target :size="24" class="text-zinc-600 mb-2" />
                 <p class="text-zinc-500 text-xs font-medium italic">No hay posiciones activas en este momento.</p>
            </div>
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-zinc-800 rounded-3xl p-8 mb-8">
          <div class="flex items-center justify-between mb-8 pb-4 border-b border-zinc-800/50">
            <h2 class="text-xl font-bold text-white flex items-center gap-3">
                <ShieldCheck :size="24" class="text-[#D4AF37]" /> 
                Señales Claude 4.6 Sonnet
            </h2>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div v-for="signal in status.pendingSignals" :key="signal.id" class="bg-[#1c1917] border border-[#D4AF37]/20 rounded-2xl p-5 hover:border-[#D4AF37]/60 transition-all flex flex-col justify-between">
              <div>
                <div class="flex justify-between items-center mb-4">
                  <span class="text-2xl font-black text-[#D4AF37] font-mono">{{ (signal.probability * 100).toFixed(0) }}%</span>
                  <span class="text-[8px] bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    IA OPTIMIZADA
                  </span>
                </div>
                <p class="text-white font-bold text-sm leading-tight mb-4 line-clamp-3" :title="signal.marketName">{{ signal.marketName }}</p>
                <div class="bg-black/40 rounded-xl p-4 border border-zinc-800/50 h-20 overflow-y-auto custom-scroll mb-4">
                  <p class="text-[10px] text-zinc-500 italic leading-relaxed font-medium">"{{ signal.reasoning }}"</p>
                </div>
              </div>
              
              <div class="flex justify-between items-center bg-[#241c18] border border-[#D4AF37]/10 rounded-xl p-3 mb-4">
                
                <div class="flex flex-col">
                  <span class="text-[8px] font-black text-zinc-500 uppercase">Edge</span>
                  <span class="text-sm font-mono font-bold" :class="Number(signal.edge) >= 0.10 ? 'text-emerald-400' : 'text-zinc-400'">
                    {{ Number(signal.edge) >= 0 ? '+' : '' }}{{ (Number(signal.edge || 0) * 100).toFixed(0) }}%
                  </span>
                </div>

                <div class="flex flex-col items-center">
                  <span class="text-[8px] font-black text-zinc-500 uppercase">Tick Size</span>
                  <span class="text-sm font-mono font-bold text-[#D4AF37]">
                    {{ signal.tickSize || '0.01' }}
                  </span>
                </div>

                <div class="flex flex-col items-end">
                  <span class="text-[8px] font-black text-zinc-500 uppercase">Sugerido</span>
                  <span class="text-sm font-mono font-bold text-white">{{ Number(signal.suggestedInversion || 0).toFixed(2) }} USDC</span>
                </div>

              </div>

              <button 
                @click="executeManualTrade(signal)" 
                :disabled="!signal.conditionId || Number(signal.edge) < 0.05"
                class="w-full py-4 rounded-xl font-black text-[10px] tracking-[0.2em] transition-all duration-300 border flex flex-col items-center justify-center gap-1"
                :class="[
                  (!signal.conditionId || Number(signal.edge) < 0.05)
                    ? 'bg-[#2A1D15] border-[#3C2A21] text-zinc-500 cursor-not-allowed opacity-70'
                    : 'bg-[#D4AF37] border-[#D4AF37] text-[#3C2A21] hover:bg-transparent hover:text-[#D4AF37] shadow-[0_0_15px_rgba(212,175,55,0.2)]'
                ]"
              >
                <template v-if="!signal.conditionId">
                  <span>SIN MERCADO ON-CHAIN</span>
                </template>
                
                <template v-else-if="Number(signal.edge) < 0.05">
                  <span>EDGE INSUFICIENTE ({{ (signal.edge * 100).toFixed(0) }}%)</span>
                </template>
                
                <template v-else>
                  <span class="tracking-[0.3em]">EJECUTAR DISPARO</span>
                  <span class="text-[8px] opacity-70 font-mono">MKT: ${{ signal.marketPrice }}</span>
                </template>
              </button>
            </div>
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-purple-500/10 rounded-3xl p-8 mb-8">
          <div class="flex items-center justify-between mb-8 pb-4 border-b border-zinc-800/50">
            <h2 class="text-xl font-bold text-white flex items-center gap-3">
                <Target :size="24" class="text-purple-500" /> 
                Operaciones Copy Trading (Whales)
            </h2>
            <div class="text-[10px] font-black uppercase tracking-widest bg-purple-500/10 text-purple-400 px-3 py-1 rounded-lg border border-purple-500/20">
              Piloto Automático
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div v-for="trade in status.copiedTrades" :key="trade.id" class="bg-[#1c1917] border border-purple-500/20 rounded-2xl p-5 hover:border-purple-500/50 transition-all flex flex-col justify-between relative overflow-hidden">
              
              <div class="absolute -right-4 -bottom-4 opacity-5 pointer-events-none">
                 <Target :size="100" class="text-purple-500" />
              </div>

              <div class="relative z-10">
                <div class="flex justify-between items-start mb-4">
                  <div class="flex flex-col">
                    <span class="text-[8px] font-black text-zinc-500 uppercase tracking-widest">Entrada MKT</span>
                    <span class="text-xl font-black text-white font-mono">${{ trade.price.toFixed(3) }}</span>
                  </div>
                  <span class="text-[9px] font-mono text-purple-400 bg-purple-500/10 px-2 py-1 rounded-lg border border-purple-500/20">
                    {{ trade.time }}
                  </span>
                </div>
                
                <p class="text-zinc-300 font-bold text-xs leading-tight mb-4 line-clamp-3" :title="trade.market">{{ trade.market }}</p>
              </div>
              
              <div class="flex justify-between items-center bg-[#171319] border border-purple-500/10 rounded-xl p-3 relative z-10">
                <div class="flex flex-col">
                  <span class="text-[8px] font-black text-zinc-500 uppercase">Whale ID</span>
                  <span class="text-xs font-mono font-bold text-purple-400">
                    {{ trade.whale.substring(0, 6) }}...{{ trade.whale.substring(trade.whale.length - 4) }}
                  </span>
                </div>

                <div class="flex flex-col items-end">
                  <span class="text-[8px] font-black text-zinc-500 uppercase">Inversión</span>
                  <span class="text-xs font-mono font-bold text-emerald-400">${{ Number(trade.size).toFixed(2) }}</span>
                </div>
              </div>

            </div>

            <div v-if="!status.copiedTrades || status.copiedTrades.length === 0" 
                 class="col-span-full bg-zinc-900/30 border border-zinc-800 border-dashed rounded-2xl p-8 text-center flex flex-col items-center justify-center">
                 <Target :size="24" class="text-zinc-600 mb-2" />
                 <p class="text-zinc-500 text-xs font-medium italic">Esperando que las ballenas realicen movimientos...</p>
            </div>
          </div>
        </div>

        <div class="bg-[#1C1612] border border-[#3C2A21] rounded-2xl overflow-hidden shadow-lg">
          <div class="p-6 border-b border-[#3C2A21] flex justify-between items-center bg-[#251B15]">
            <h3 class="text-zinc-400 font-black text-xs tracking-widest uppercase flex items-center gap-2">
              <Activity :size="14" class="text-zinc-500" />
              Historial de Ejecuciones (Cerradas)
            </h3>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-[10px] text-zinc-500 uppercase tracking-tighter border-b border-[#3C2A21]">
                  <th class="p-4 font-medium w-28">Actividad</th>
                  <th class="p-4 font-medium">Mercado</th>
                  <th class="p-4 font-medium text-right">Valor</th>
                  <th class="p-4 font-medium text-right">Tiempo</th>
                </tr>
              </thead>

              <tbody class="text-xs">
                <tr v-for="exec in status.executions" :key="exec.id" class="border-b border-[#3C2A21]/50 hover:bg-[#2A1D15] transition-colors">
                  
                  <td class="p-4 font-bold text-xs whitespace-nowrap">
                    <div v-if="exec.status === 'Vendido'" class="text-zinc-300 flex items-center gap-2">
                      <div class="w-4 h-4 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] text-zinc-400 font-black">−</div> Vendido
                    </div>
                    <div v-else-if="exec.status === 'Comprado'" class="text-zinc-300 flex items-center gap-2">
                      <div class="w-4 h-4 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] text-zinc-400 font-black">+</div> Comprado
                    </div>
                    <div v-else-if="exec.status === 'Perdido'" class="text-rose-500 flex items-center gap-2">
                      <div class="w-4 h-4 rounded-full bg-rose-500/20 flex items-center justify-center text-[10px] text-rose-500 font-black">×</div> Perdido
                    </div>
                  </td>
                  
                  <td class="p-4">
                    <div class="font-bold text-zinc-300 mb-1.5 leading-snug pr-4">{{ exec.market }}</div>
                    <div class="flex items-center gap-2">
                      <span class="px-2 py-0.5 rounded text-[10px] font-bold"
                            :class="exec.outcome === 'Yes' || exec.outcome === 'Over' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'">
                        {{ exec.outcome }} {{ exec.priceCents }}¢
                      </span>
                      <span class="text-[10px] text-zinc-500 font-medium">{{ exec.shares }} acciones</span>
                    </div>
                  </td>
                  
                  <td class="p-4 font-mono font-bold text-right text-sm">
                    <div v-if="exec.status === 'Vendido'" class="text-emerald-500">
                      +${{ exec.inversion?.toFixed(2) }}
                    </div>
                    <div v-else-if="exec.status === 'Comprado'" class="text-zinc-300">
                      -${{ exec.inversion?.toFixed(2) }}
                    </div>
                    <div v-else-if="exec.status === 'Perdido'" class="text-zinc-600">
                      -
                    </div>
                  </td>

                  <td class="p-4 text-[10px] text-zinc-500 font-mono text-right whitespace-nowrap">
                    {{ exec.time }}
                  </td>

                </tr>
                <tr v-if="!status.executions || status.executions.length === 0">
                  <td colspan="4" class="p-12 text-center text-zinc-600 italic border-t border-[#3C2A21]/50">El historial está vacío.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-[#D4AF37]/20 rounded-3xl p-8 mb-8 shadow-[0_0_40px_rgba(212,175,55,0.05)] relative overflow-hidden group">
          <div class="absolute -right-10 -top-10 opacity-5 group-hover:opacity-10 transition-all duration-700 rotate-12">
            <Target :size="200" class="text-[#D4AF37]" />
          </div>
          <div class="flex items-center justify-between mb-8 relative z-10">
            <h2 class="text-[#D4AF37] font-black text-2xl tracking-tighter flex items-center gap-3">
              <Target :size="28" class="animate-pulse text-[#D4AF37]" /> RADAR DE INTELIGENCIA
            </h2>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
            <template v-if="status.watchlist && status.watchlist.length > 0">
              <div v-for="(market, index) in status.watchlist.slice(0, 4)" :key="index"
                  class="bg-black/40 border border-[#3C2A21] p-5 rounded-2xl hover:border-[#D4AF37]/30 transition-all flex flex-col justify-between">
                <div>
                  <div class="flex justify-between items-start mb-2">
                    <span class="text-[10px] font-black text-[#D4AF37] uppercase tracking-widest">{{ market.category || 'SCAN' }}</span>
                    <span v-if="market.endsIn" class="text-[9px] font-mono text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded">⏰ {{ market.endsIn }}</span>
                  </div>
                  <p class="text-zinc-200 font-bold text-sm leading-tight mb-2 line-clamp-2" :title="market.title">{{ market?.title }}</p>
                </div>
                <div class="flex items-center justify-between text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600 mt-3 pt-3 border-t border-zinc-800/50">
                  <span class="flex items-center gap-1"><div class="w-1 h-1 bg-[#D4AF37] rounded-full animate-pulse"></div> Evaluando...</span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="bg-[#0a0a0a] border border-[#D4AF37]/30 rounded-3xl p-5 shadow-2xl mt-8">
          <div class="flex justify-between items-center mb-4 border-b border-[#D4AF37]/20 pb-3">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <h3 class="text-[10px] text-[#D4AF37] font-black uppercase tracking-[0.2em]">Live Terminal</h3>
            </div>
            <button @click="fetchLogs" class="text-[10px] text-zinc-400 hover:text-[#D4AF37] uppercase tracking-widest font-bold transition-colors border border-zinc-800 hover:border-[#D4AF37]/50 px-3 py-1 rounded-lg">
              Actualizar
            </button>
          </div>
          
          <div class="h-64 overflow-y-auto custom-scroll flex flex-col gap-1.5 font-mono text-[10px] sm:text-xs pr-2 bg-black/50 p-3 rounded-xl border border-zinc-900">
            <div v-for="(log, i) in systemLogs" :key="i" class="leading-relaxed border-b border-zinc-900/50 pb-1" :class="log.type === 'error' ? 'text-rose-500' : 'text-zinc-300'">
              <span class="text-zinc-600 mr-2">[{{ log.time }}]</span>
              <span v-if="log.type === 'error'" class="mr-1">❌</span>
              <span v-else-if="log.message.includes('🎯')" class="mr-1"></span>
              <span v-else class="text-zinc-500 mr-1">></span>
              {{ log.message }}
            </div>
            <div v-if="systemLogs.length === 0" class="text-zinc-600 italic text-center mt-10">
              Esperando actividad del servidor...
            </div>
          </div>
        </div>

      </div>

      <div class="col-span-12 xl:col-span-4 h-full space-y-6">

        <div class="bg-[#1c1917] border-2 border-[#D4AF37]/20 rounded-3xl p-5 flex items-center justify-between gap-6 shadow-xl relative overflow-hidden group">
          
          <div class="shrink-0 relative z-10 w-[60px] sm:w-auto">
            <h3 class="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1 leading-tight sm:leading-normal">Filtro<br class="sm:hidden"> Sens.</h3>
            <div class="flex items-baseline gap-1">
              <span class="text-[#D4AF37] font-mono text-2xl font-black leading-none">
                {{ ((status.predictionThreshold || 0.70) * 100).toFixed(0) }}
              </span>
              <span class="text-[#D4AF37] text-xs font-bold">%</span>
            </div>
          </div>
          
          <div class="flex-1 flex flex-col gap-2 relative z-10 px-2 justify-center">
            <input 
              type="range"
              min="0.10" max="0.95" step="0.01"
              v-model.number="status.predictionThreshold"
              @change="updateThreshold"
              class="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
            />
            <div class="flex justify-between text-[8px] text-zinc-500 uppercase tracking-widest font-black px-1 flex-col sm:flex-row text-center sm:text-left gap-1 sm:gap-0">
              <span class="hover:text-amber-500 cursor-pointer transition-colors" @click="setThreshold(0.50)">50% Riesgo</span>
              <span class="hover:text-emerald-500 cursor-pointer transition-colors" @click="setThreshold(0.85)">85% Seguro</span>
            </div>
          </div>
          
          <div class="text-[7.5px] sm:text-[9px] shrink-0 font-black w-20 sm:w-24 leading-tight uppercase text-center py-2 px-1 rounded-lg border transition-all duration-300 relative z-10"
              :class="(status.predictionThreshold || 0.70) >= 0.75 
                  ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40'
                  : (status.predictionThreshold || 0.70) <= 0.40 
                    ? 'text-red-500 bg-red-500/10 border-red-500/40' 
                    : 'text-amber-400 bg-amber-400/10 border-amber-400/40'">
            {{ (status.predictionThreshold || 0.70) >= 0.75 ? 'MODO SEGURO' : ((status.predictionThreshold || 0.70) <= 0.40 ? 'ALTO RIESGO' : 'ESTÁNDAR') }}
          </div>
          
        </div>

        <div class="bg-[#1c1917] border-2 border-[#D4AF37]/20 rounded-3xl p-5 flex items-center justify-between gap-6 shadow-xl relative overflow-hidden group mt-6 mb-6">
          
          <div class="shrink-0 relative z-10">
            <h3 class="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1">Mínimo Edge</h3>
            <div class="flex items-baseline gap-1">
              <span class="text-[#D4AF37] font-mono text-2xl font-black leading-none">
                {{ ((status.edgeThreshold || 0.08) * 100).toFixed(0) }}
              </span>
              <span class="text-[#D4AF37] text-xs font-bold">%</span>
            </div>
          </div>
          
          <div class="flex-1 flex flex-col gap-2 relative z-10 px-2 justify-center">
            <input 
              type="range"
              min="0.02" max="0.30" step="0.01"
              v-model.number="status.edgeThreshold"
              @change="updateEdge"
              class="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
            />
            <div class="flex justify-between text-[8px] text-zinc-500 uppercase tracking-widest font-black px-1">
              <span class="hover:text-rose-500 cursor-pointer transition-colors" @click="setEdge(0.04)">4% Agresivo</span>
              <span class="hover:text-emerald-500 cursor-pointer transition-colors" @click="setEdge(0.15)">15% Seguro</span>
            </div>
          </div>
          
          <div class="text-[9px] font-black w-24 leading-tight uppercase text-center py-2 px-1 rounded-lg border transition-all duration-300 relative z-10"
              :class="(status.edgeThreshold || 0.08) >= 0.12 
                  ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40'
                  : (status.edgeThreshold || 0.08) <= 0.05 
                    ? 'text-rose-500 bg-rose-500/10 border-rose-500/40' 
                    : 'text-amber-400 bg-amber-400/10 border-amber-400/40'">
            {{ (status.edgeThreshold || 0.08) >= 0.12 ? 'CONSERVADOR' : ((status.edgeThreshold || 0.08) <= 0.05 ? 'FRANCOTIRADOR' : 'ESTÁNDAR') }}
          </div>
        </div>

        <div class="bg-[#1c1917] border-2 border-emerald-500/20 rounded-3xl p-5 flex items-center justify-between gap-6 shadow-xl relative overflow-hidden group mb-8">
          
          <div class="shrink-0 relative z-10">
            <h3 class="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1">Take Profit</h3>
            <div class="flex items-baseline gap-1">
              <span class="text-emerald-500 font-mono text-2xl font-black leading-none">
                {{ status.takeProfitThreshold || 15 }}
              </span>
              <span class="text-emerald-500 text-xs font-bold">%</span>
            </div>
          </div>
          
          <div class="flex-1 flex flex-col gap-2 relative z-10 px-2 justify-center">
            <input 
              type="range"
              min="5" max="50" step="1"
              v-model.number="status.takeProfitThreshold"
              @change="updateTakeProfit"
              class="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div class="flex justify-between text-[8px] text-zinc-500 uppercase tracking-widest font-black px-1">
              <span class="hover:text-emerald-400 cursor-pointer transition-colors" @click="setTakeProfit(10)">10% Scalping</span>
              <span class="hover:text-amber-500 cursor-pointer transition-colors" @click="setTakeProfit(30)">30% Holdeo</span>
            </div>
          </div>
          
          <div class="text-[9px] font-black w-24 leading-tight uppercase text-center py-2 px-1 rounded-lg border transition-all duration-300 relative z-10"
              :class="(status.takeProfitThreshold || 15) >= 25 
                  ? 'text-amber-500 bg-amber-500/10 border-amber-500/40'
                  : (status.takeProfitThreshold || 15) <= 10 
                    ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' 
                    : 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40'">
            {{ (status.takeProfitThreshold || 15) >= 25 ? 'PACIENTE' : ((status.takeProfitThreshold || 15) <= 10 ? 'AGRESIVO' : 'ESTÁNDAR') }}
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-emerald-500/20 hover:border-emerald-500/50 rounded-3xl p-6 transition-all shadow-xl relative overflow-hidden group">
          <div class="absolute -right-6 -top-6 opacity-5 group-hover:opacity-10 transition-all duration-700">
            <Cpu :size="120" class="text-emerald-500" />
          </div>
          
          <div class="relative z-10 flex items-center justify-between mb-4 pb-4 border-b border-zinc-800">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-emerald-500/10 rounded-xl border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
                <Cpu :size="20" class="text-emerald-500" />
              </div>
              <div>
                <h3 class="text-white font-black text-sm tracking-wide">Autopilot Sniper</h3>
                <p class="text-[10px] text-zinc-500 uppercase tracking-widest mt-0.5">Disparo Automático</p>
              </div>
            </div>
            
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input type="checkbox" v-model="status.autoTradeEnabled" @change="updateAutoTrade" class="sr-only peer">
              <div class="w-11 h-6 bg-zinc-800 rounded-full peer peer-focus:ring-2 peer-focus:ring-emerald-500/20 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-300 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 group-hover/toggle:shadow-[0_0_15px_rgba(16,185,129,0.3)]"></div>
            </label>
          </div>

          <div class="relative z-10 flex items-center justify-between bg-black/40 p-3 rounded-2xl border border-zinc-800 focus-within:border-emerald-500/30">
            <div class="flex flex-col">
              <span class="text-[9px] text-zinc-500 font-black uppercase tracking-widest pl-2 mb-1">Monto por Disparo</span>
              <div class="flex items-center gap-2 px-2">
                <span class="text-emerald-500 font-bold">$</span>
                <input 
                  type="number" 
                  v-model.number="status.microBetAmount" 
                  @change="updateAutoTrade"
                  min="0.5" step="0.5"
                  class="bg-transparent text-white font-mono text-xl w-24 focus:outline-none placeholder:text-zinc-700 disabled:cursor-not-allowed" 
                  :disabled="!status.autoTradeEnabled"
                  :class="{'opacity-50': !status.autoTradeEnabled}"
                />
              </div>
            </div>
            <div class="text-[10px] font-black flex items-center gap-2 uppercase border border-zinc-800 px-3 py-1.5 rounded-lg text-zinc-400 bg-zinc-900 transition-colors" :class="status.autoTradeEnabled ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' : ''">
              <div v-if="status.autoTradeEnabled" class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span>{{ status.autoTradeEnabled ? 'ARMADO' : 'SEGURO' }}</span>
            </div>
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-emerald-500/20 hover:border-emerald-500/50 rounded-3xl p-6 transition-all shadow-xl">
          <div class="flex items-center justify-between mb-4 pb-4 border-b border-zinc-800">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                <ShieldCheck :size="20" class="text-emerald-500" />
              </div>
              <div>
                <h3 class="text-white font-black text-sm tracking-wide">Filtro de Mercados</h3>
                <p class="text-[10px] text-zinc-500">Apaga sectores con alta volatilidad</p>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label v-for="key in filterOrder" :key="key" class="flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all"
                  :class="status.marketFilters[key] ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-zinc-900 border-zinc-800 opacity-50 hover:opacity-100'">
              <span class="text-xs font-bold text-white capitalize">{{ key }}</span>
              <input type="checkbox" v-model="status.marketFilters[key]" @change="updateFilters" class="sr-only">
              <div class="w-3 h-3 rounded-full" :class="status.marketFilters[key] ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'bg-zinc-600'"></div>
            </label>
          </div>
        </div>

        <!-- ==================== COPY TRADING CONTROLS ==================== -->
        <div class="bg-[#111114] border-2 border-purple-500/20 hover:border-purple-500/50 rounded-3xl p-6 transition-all shadow-xl">
          <div class="flex items-center justify-between mb-4 pb-4 border-b border-zinc-800">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-purple-500/10 rounded-xl border border-purple-500/20">
                <Target :size="20" class="text-purple-500" />
              </div>
              <div>
                <h3 class="text-white font-black text-sm tracking-wide">Copy Trading</h3>
                <p class="text-[10px] text-zinc-500">Copiar a las mejores whales</p>
              </div>
            </div>
            
            <!-- Toggle corregido (igual estilo que Autopilot) -->
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input 
                type="checkbox" 
                v-model="status.copyTradingEnabled" 
                @change="updateCopyTrading"
                class="sr-only peer"
              >
              <div class="w-11 h-6 bg-zinc-800 rounded-full peer peer-focus:ring-2 peer-focus:ring-purple-500/20 
                          peer-checked:after:translate-x-full peer-checked:after:border-white 
                          after:content-[''] after:absolute after:top-[2px] after:left-[2px] 
                          after:bg-zinc-300 after:border-gray-300 after:border after:rounded-full 
                          after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500 
                          group-hover/toggle:shadow-[0_0_15px_rgba(168,85,247,0.3)]"></div>
            </label>
          </div>

          <div v-if="status.copyTradingEnabled" class="space-y-5">
            
            <!-- Tamaño máximo por copia -->
            <div>
              <div class="flex justify-between text-xs mb-1.5">
                <span class="text-zinc-400">Tamaño máximo por copia</span>
                <span class="font-mono text-purple-400">{{ status.maxCopySize }} shares</span>
              </div>
              <input 
                type="range" 
                min="10" 
                max="200" 
                step="5"
                v-model.number="status.maxCopySize"
                @change="updateCopyTrading"
                class="w-full accent-purple-500"
              >
            </div>

            <!-- % máximo del balance -->
            <div>
              <div class="flex justify-between text-xs mb-1.5">
                <span class="text-zinc-400">% máximo del balance por copia</span>
                <span class="font-mono text-purple-400">{{ status.maxCopyPercentOfBalance }}%</span>
              </div>
              <input 
                type="range" 
                min="2" 
                max="15" 
                step="1"
                v-model.number="status.maxCopyPercentOfBalance"
                @change="updateCopyTrading"
                class="w-full accent-purple-500"
              >
            </div>

            <!-- Cantidad de ballenas seleccionadas -->
             <div>
              <div class="flex justify-between text-xs mb-1.5">
                <span class="text-zinc-400">Cantidad de ballenas a copiar</span>
                <span class="font-mono text-purple-400">{{ status.maxWhalesToCopy || 10 }}</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="20" 
                step="1"
                v-model.number="status.maxWhalesToCopy"
                @change="updateCopyTrading"
                class="w-full accent-purple-500"
              >
            </div>

            <!-- Lista de Whales seleccionadas -->
            <div>
              <p class="text-xs text-zinc-400 mb-2">Whales seleccionadas automáticamente</p>
              <div class="max-h-52 overflow-y-auto custom-scroll space-y-2 text-xs">
                <div v-for="(whale, i) in status.autoSelectedWhales || []" :key="i"
                     class="bg-zinc-900/70 border border-zinc-700 rounded-xl p-3">
                  <div class="font-mono text-purple-400 text-[10px]">{{ whale.address.substring(0,12) }}...</div>
                  <div class="flex justify-between text-[10px] mt-1 text-zinc-400">
                    <span>PnL: <span class="text-emerald-400">${{ Number(whale.pnl || 0).toLocaleString() }}</span></span>
                    <span>Vol: ${{ Number(whale.volume || 0).toLocaleString() }}</span>
                  </div>
                </div>
                <div v-if="!status.autoSelectedWhales || status.autoSelectedWhales.length === 0" 
                     class="text-center py-4 text-zinc-500 text-xs">
                  Esperando selección automática...
                </div>
              </div>
            </div>
          </div>

          <div v-else class="text-center py-8 text-zinc-500 text-sm italic">
            Activa Copy Trading para seguir automáticamente a las mejores ballenas
          </div>
        </div>
        
        <div class="bg-[#111114] border-2 border-zinc-800 rounded-3xl p-6 shadow-xl">
          <h3 class="text-zinc-400 font-black text-xs uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
            <Activity :size="14" class="text-zinc-500" />
            Estado del Sistema
          </h3>
          
          <div class="space-y-3">
            <div class="flex justify-between items-center bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
              <span class="text-[10px] text-zinc-500 font-black uppercase tracking-widest">Conexión CLOB</span>
              <span class="text-xs font-mono font-bold text-emerald-400 flex items-center gap-1.5">
                <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div> EOA Active
              </span>
            </div>
            
            <div class="flex justify-between items-center bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
              <span class="text-[10px] text-zinc-500 font-black uppercase tracking-widest">Motor IA</span>
              <span class="text-xs font-mono font-bold text-[#D4AF37]">Claude 4.6 Sonnet</span>
            </div>

            <div class="flex justify-between items-center bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
              <span class="text-[10px] text-zinc-500 font-black uppercase tracking-widest">Último Escaneo</span>
              <span class="text-xs font-mono font-bold text-zinc-300">{{ status.lastCheck || 'Iniciando...' }}</span>
            </div>
          </div>
        </div>

      </div>

    </main>

    <footer class="max-w-[1600px] mx-auto mt-16 text-center text-xs text-zinc-700 border-t border-zinc-800/50 pt-8">
      Premium Financial Tools • PolyBot v1.0 • {{ status.balancePOL < 0.1 ? '⚠️ GAS BAJO' : 'RED OK' }}
    </footer>
  </div>
</template>

<style>
/* Trading Dark Palette */
body { background-color: #09090b; color: #d4d4d8; font-feature-settings: "tnum"; }

/* Neo-Brutalism Scrollbar */
.custom-scroll::-webkit-scrollbar { width: 6px; }
.custom-scroll::-webkit-scrollbar-track { background: transparent; }
.custom-scroll::-webkit-scrollbar-thumb { background: #27272a; border-radius: 10px; }
.custom-scroll::-webkit-scrollbar-thumb:hover { background: #3f3f46; }

/* Simple scale animation */
@keyframes pulse-soft { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.animate-pulse { animation: pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
/* Eliminar selectores grises en Chrome, Safari, Edge y Opera */
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

/* Eliminar selectores grises en Firefox */
input[type=number] {
  -moz-appearance: textfield;
  appearance: none;
}
</style>