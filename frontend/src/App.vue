<script setup>
import { ref, onMounted, computed, onUnmounted } from 'vue'
import axios from 'axios'
import { 
  Activity, ShieldCheck, Target, Cpu, Bot, Clock3, Power, ArrowUpRight, Lock, LifeBuoy, Server
} from 'lucide-vue-next'
import Swal from 'sweetalert2';

// Antes: const API_URL = 'http://localhost:3001/api';
// Ahora: Dinámico según el entorno
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// --- ESTADO REACTIVO UNIFICADO ---
const status = ref({
  // 1. Variables Generales del Dashboard (Intactas)
  lastCheck: null,
  lastProbability: 0,
  currentMarket: { title: 'Cargando radar...' },
  lastNews: [],
  balanceUSDC: '0.00',
  balancePOL: '0.00',
  executions: [],
  pendingSignals: [],
  autoTradeEnabled: true,
  isPanicStopped: false,
  //microBetAmount: 1.00,
  microBetAmount: 0.50,
  marketFilters: { crypto: true, politics: true, business: true, sports: false, pop: false },
  maxActiveSportsMarkets: 2,
  
  // 2. Variables Generales de Copy Trading (Intactas)
  copyTradingEnabled: false,
  maxCopySize: 50,
  autoSelectedWhales: [],
  copiedTrades: [],

  // 3. 👇 NUEVA ARQUITECTURA DE PERFILES (Doble Cerebro)
  activeProfileName: 'standardConfig', // Controla el Switch visual
  
  // VERSION GROOK
    standardConfig: {
        predictionThreshold: 0.75,      // subido de 0.70
        edgeThreshold: 0.105,           // subido de 0.09
        takeProfitThreshold: 20,
        stopLossThreshold: -18,         // más paciente que -20
        maxCopyPercentOfBalance: 8
    },

    volatileConfig: {
        predictionThreshold: 0.82,
        edgeThreshold: 0.13,
        takeProfitThreshold: 12,        // más conservador en take profit
        stopLossThreshold: -12,         // más conservador que -10
        maxCopyPercentOfBalance: 4      // menos riesgo en volatile
    },
    // 4. 👇 VARIABLES DE TELEMETRIA
    systemMetrics: {
      botRamMB: 0,
      serverTotalRamMB: 0,
      serverFreeRamMB: 0,
      uptimeHours: 0,
      cpuLoad: 0
  }

});

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
      // 🔥 FIX: Leemos el monto dinámicamente según el perfil que esté activo
      amount: status.value[status.value.activeProfileName].microBetAmount
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
      // 🔥 FIX: Dispara usando el monto de la pestaña en la que estás parado
      amount: status.value[status.value.activeProfileName].microBetAmount,
      conditionId: signal.conditionId,
      tokenId: signal.tokenId,
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

// --- ⚖️ FUNCIONES DE RIESGO BIFURCADO ---
const updateRiskSettings = async () => {
  try {
    const profileName = status.value.activeProfileName;
    const config = status.value[profileName];
    const profileStr = profileName === 'standardConfig' ? 'ESTANDAR' : 'VOLATIL';

    await axios.post(`${API_URL}/settings/autotrade`, { 
      profile: profileStr,
      predictionThreshold: config.predictionThreshold,
      edgeThreshold: config.edgeThreshold,
      takeProfitThreshold: config.takeProfitThreshold,
      stopLossThreshold: config.stopLossThreshold,
      // Opcional: también puedes enviar maxCopyPercent si quieres
      maxCopyPercentOfBalance: config.maxCopyPercentOfBalance,
      microBetAmount: config.microBetAmount
    });

    console.log(`✅ Configuración guardada para perfil ${profileStr}`);
  } catch (error) {
    console.error("❌ Error al guardar configuración de riesgo:", error.message);
  }
};

// --- 🚨 BOTÓN DE FRENO DE EMERGENCIA / DESBLOQUEO ---
const triggerPanicStop = async () => {
  try {
    const action = status.value.isPanicStopped ? 'resume' : 'stop';
    
    Swal.fire({
      title: action === 'stop' ? 'Activando Freno...' : 'Liberando Candado...',
      background: '#1c1917',
      color: '#D4AF37',
      didOpen: () => { Swal.showLoading(); }
    });

    await axios.post(`${API_URL}/panic`, { action });
    await fetchStatus(); 
    
    Swal.fire({
      title: action === 'stop' ? 'SISTEMA DETENIDO' : 'SISTEMA REACTIVADO',
      text: action === 'stop' ? 'El bot no comprará ni venderá nada.' : 'El bot vuelve a operar con normalidad.',
      icon: action === 'stop' ? 'warning' : 'success',
      background: '#1c1917',
      color: '#fff',
      confirmButtonColor: '#D4AF37'
    });
  } catch (error) {
    console.error("Error en panic stop:", error);
  }
};

const updateCopySettings = async () => {
  try {
    const profileStr = status.value.activeProfileName === 'standardConfig' ? 'ESTANDAR' : 'VOLATIL';
    const config = status.value[status.value.activeProfileName];

    await axios.post(`${API_URL}/settings/copytrading`, { 
      profile: profileStr,
      maxCopySize: status.value.maxCopySize,
      maxCopyPercent: config.maxCopyPercentOfBalance
    });
  } catch (error) {
    console.error('Error updating copy settings:', error);
  }
};

const updateCopyTrading = async () => {
  try {
    const currentProfile = status.value[status.value.activeProfileName];

    await axios.post(`${API_URL}/settings/copytrading`, {
      enabled: status.value.copyTradingEnabled,
      maxCopySize: status.value.maxCopySize || 50,
      maxCopyPercent: currentProfile.maxCopyPercentOfBalance || 8,   // ← Corregido
      maxWhalesToCopy: status.value.maxWhalesToCopy || 5,
      
      // Enviamos el perfil actual para que el backend sepa qué modo de riesgo usar
      profile: status.value.activeProfileName === 'standardConfig' ? 'ESTANDAR' : 'VOLATIL'
    });

    console.log(`✅ Copy Trading actualizado | Perfil: ${status.value.activeProfileName} | Max %: ${currentProfile.maxCopyPercentOfBalance}%`);
  } catch (error) {
    console.error("❌ Error actualizando Copy Trading settings:", error.message);
  }
};

const updateFilters = async () => {
  try {
    await axios.post(`${API_URL}/settings/filters`, status.value.marketFilters);
  } catch (error) {
    console.error("Error actualizando filtros", error);
  }
};

// --- ⚙️ ACTUALIZAR CONFIGURACIÓN GENERAL (LIMITES) ---
const updateConfig = async () => {
  try {
    await axios.post(`${API_URL}/settings/config`, {
      maxActiveSportsMarkets: status.value.maxActiveSportsMarkets
    });
    console.log(`✅ Límite de deportes actualizado a: ${status.value.maxActiveSportsMarkets === 0 ? 'ILIMITADO' : status.value.maxActiveSportsMarkets}`);
  } catch (error) {
    console.error("❌ Error actualizando límite de deportes", error);
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

const switchProfile = async (profileName) => {
  // Solo cambiamos si es diferente
  if (status.value.activeProfileName === profileName) return;

  status.value.activeProfileName = profileName;

  console.log(`🔄 Editando perfil: ${profileName === 'standardConfig' ? 'ESTÁNDAR' : 'VOLÁTIL'}`);

  // Guardamos inmediatamente los cambios del perfil que acabamos de dejar
  await updateRiskSettings();
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

        <button @click="triggerPanicStop" class="flex items-center gap-2.5 px-5 py-3 rounded-full text-sm font-bold transition active:scale-95 group border"
                :class="status.isPanicStopped ? 'bg-amber-950/40 text-amber-500 border-amber-500/20 hover:bg-amber-900/60' : 'bg-red-950 text-red-300 border-transparent hover:bg-red-900'">
          <Power :size="18" :class="status.isPanicStopped ? 'text-amber-500' : 'text-red-500 group-hover:animate-pulse'" />
          {{ status.isPanicStopped ? 'QUITAR CANDADO' : 'EMERGENCY STOP' }}
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
                <Bot :size="24" class="text-[#D4AF37]" /> 
                Señales Multi-Agente
            </h2>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div v-for="signal in status.pendingSignals" :key="signal.id" class="bg-[#1c1917] border border-[#D4AF37]/20 rounded-2xl p-5 hover:border-[#D4AF37]/60 transition-all flex flex-col justify-between">
              <div>
                <div class="flex justify-between items-center mb-4">
                  <span class="text-2xl font-black text-[#D4AF37] font-mono">{{ (signal.probability * 100).toFixed(0) }}%</span>
                  
                  <span v-if="signal.engine && signal.engine.includes('Trinity')" class="text-[9px] bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded-md border border-purple-500/30 font-black tracking-widest flex items-center gap-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse"></span> TRINITY
                  </span>
                  <span v-else-if="signal.engine && signal.engine.includes('Consenso')" class="text-[9px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-md border border-emerald-500/30 font-black tracking-widest flex items-center gap-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> CONSENSO
                  </span>
                  <span v-else-if="signal.engine === 'Grok'" class="text-[9px] bg-red-500/10 text-red-400 px-2 py-0.5 rounded-md border border-red-500/30 font-black tracking-widest flex items-center gap-1">
                    𝕏 GROK
                  </span>
                  <span v-else-if="signal.engine === 'Gemini'" class="text-[9px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-md border border-blue-500/30 font-black tracking-widest flex items-center gap-1">
                    🔮 GEMINI
                  </span>
                  <span v-else class="text-[9px] bg-[#D4AF37]/10 text-[#D4AF37] px-2 py-0.5 rounded-md border border-[#D4AF37]/30 font-black tracking-widest flex items-center gap-1">
                    🧠 CLAUDE
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

        <div class="mb-6 bg-[#1C1612] border border-[#D4AF37]/20 rounded-[2rem] p-6 relative overflow-hidden group shadow-2xl">
          <div class="absolute -top-24 -right-24 w-48 h-48 bg-[#D4AF37] rounded-full blur-[80px] opacity-5 pointer-events-none"></div>
          
          <div class="flex items-center justify-between mb-6 relative z-10">
            <div class="flex items-center gap-4">
              <div class="p-3 rounded-xl bg-[#D4AF37]/10 border border-[#D4AF37]/20 text-[#D4AF37]">
                <Server :size="20" />
              </div>
              <div>
                <h3 class="text-white font-bold text-sm tracking-tight uppercase">Telemetría de Sistema</h3>
                <p class="text-[10px] text-zinc-500 font-medium"> VPS Toronto Core • Status: <span class="text-emerald-500 text-[9px] animate-pulse">● LIVE</span></p>
              </div>
            </div>
          </div>

            <div class="grid grid-cols-2 gap-3 relative z-10">
            <div class="bg-[#161210] border border-[#D4AF37]/10 p-3 rounded-xl hover:border-[#D4AF37]/30 transition-colors">
              <div class="flex items-center gap-2 mb-1">
                <Activity :size="12" class="text-[#D4AF37]/60" />
                <span class="text-[9px] text-zinc-500 font-black uppercase tracking-widest">RAM Bot</span>
              </div>
              <p class="text-lg font-mono font-black text-zinc-200">
                {{ status.systemMetrics?.botRamMB || '0.00' }}<span class="text-[10px] text-[#D4AF37] ml-1">MB</span>
              </p>
            </div>

            <div class="bg-[#161210] border border-[#D4AF37]/10 p-3 rounded-xl">
              <div class="flex items-center gap-2 mb-1">
                <Cpu :size="12" class="text-[#D4AF37]/60" />
                <span class="text-[9px] text-zinc-500 font-black uppercase tracking-widest">Carga CPU</span>
              </div>
              <p class="text-lg font-mono font-black text-zinc-200">
                {{ status.systemMetrics?.cpuLoad || '0.00' }}<span class="text-[10px] text-[#D4AF37] ml-1">AVG</span>
              </p>
            </div>

            <div class="bg-[#161210] border border-[#D4AF37]/10 p-3 rounded-xl">
              <div class="flex items-center gap-2 mb-1">
                <LifeBuoy :size="12" class="text-[#D4AF37]/60" />
                <span class="text-[9px] text-zinc-500 font-black uppercase tracking-widest">Libre (OS)</span>
              </div>
              <p class="text-lg font-mono font-black text-zinc-200">
                {{ Math.round(status.systemMetrics?.serverFreeRamMB) || '0' }}<span class="text-[10px] text-[#D4AF37] ml-1">MB</span>
              </p>
            </div>

            <div class="bg-[#161210] border border-[#D4AF37]/10 p-3 rounded-xl">
              <div class="flex items-center gap-2 mb-1">
                <Clock3 :size="12" class="text-[#D4AF37]/60" />
                <span class="text-[9px] text-zinc-500 font-black uppercase tracking-widest">Uptime</span>
              </div>
              <p class="text-lg font-mono font-black text-zinc-200">
                {{ status.systemMetrics?.uptimeHours || '0.00' }}<span class="text-[10px] text-[#D4AF37] ml-1">HRS</span>
              </p>
            </div>
          </div>
        </div>        

        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-lg"
             :class="status.activeProfileName === 'standardConfig' ? 'shadow-[0_0_50px_rgba(14,165,233,0.03)] hover:border-sky-500/30' : 'shadow-[0_0_50px_rgba(249,115,22,0.03)] hover:border-orange-500/30'">
          
          <div class="absolute -top-32 -right-32 w-64 h-64 rounded-full blur-[100px] opacity-20 pointer-events-none transition-colors duration-700"
               :class="status.activeProfileName === 'standardConfig' ? 'bg-sky-500' : 'bg-orange-500'"></div>

          <div class="flex flex-col gap-5 mb-8 relative z-10">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border transition-colors duration-500 shadow-inner shrink-0"
                   :class="status.activeProfileName === 'standardConfig' ? 'bg-sky-500/10 border-sky-500/20 text-sky-400' : 'bg-orange-500/10 border-orange-500/20 text-orange-400'">
                <ShieldCheck :size="24" />
              </div>
              <div>
                <h3 class="text-white font-black text-lg tracking-tight">Gestión de Riesgo</h3>
                <p class="text-xs text-zinc-500 font-medium">Ajuste algorítmico por sector</p>
              </div>
            </div>

            <div class="flex p-1.5 bg-[#09090b] rounded-xl border border-zinc-800/80 w-full shadow-inner">
              <button 
                @click="switchProfile('standardConfig')"
                :class="status.activeProfileName === 'standardConfig' ? 'bg-sky-500/15 text-sky-400 border-sky-500/20 shadow-[0_0_15px_rgba(14,165,233,0.1)]' : 'text-zinc-500 border-transparent hover:text-zinc-300'"
                class="flex-1 px-2 py-3 rounded-lg text-[10px] sm:text-[11px] font-black uppercase tracking-widest border transition-all duration-300 flex justify-center items-center">
                  📘 Crypto / Política
              </button>
              <button 
                @click="switchProfile('volatileConfig')"
                :class="status.activeProfileName === 'volatileConfig' ? 'bg-orange-500/15 text-orange-400 border-orange-500/20 shadow-[0_0_15px_rgba(249,115,22,0.1)]' : 'text-zinc-500 border-transparent hover:text-zinc-300'"
                class="flex-1 px-2 py-3 rounded-lg text-[10px] sm:text-[11px] font-black uppercase tracking-widest border transition-all duration-300 flex justify-center items-center">
                  📙 Deportes / Pop
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-5 relative z-10">

            <div class="mb-5 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80 flex items-center justify-between group hover:border-[#D4AF37]/40 transition-colors">
              <div>
                <h4 class="text-[11px] font-black uppercase tracking-widest text-zinc-400 group-hover:text-zinc-300 transition-colors">Tamaño de la Bala</h4>
                <p class="text-[10px] text-zinc-500 font-medium mt-0.5">Inversión fija por trade (USDC)</p>
              </div>
              <div class="relative w-32 shadow-inner rounded-lg">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 font-black">$</span>
                <input 
                  type="number" 
                  step="0.50" 
                  min="0.50"
                  v-model.number="status[status.activeProfileName].microBetAmount"
                  @change="updateRiskSettings"
                  class="w-full bg-[#161210] border border-zinc-700 text-zinc-200 text-sm font-mono font-black rounded-lg py-2 pl-7 pr-3 focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37]/50 transition-all text-right"
                />
              </div>
            </div>

            <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors">
              <div class="flex justify-between items-center mb-4">
                <label class="text-[11px] text-zinc-400 font-bold uppercase tracking-widest whitespace-nowrap">Filtro Sens.</label>
                <span class="text-[9px] font-black px-2 py-1 rounded-md border shrink-0 whitespace-nowrap" :class="status.activeProfileName === 'standardConfig' ? 'text-sky-400 bg-sky-400/10 border-sky-400/20' : 'text-orange-400 bg-orange-400/10 border-orange-400/20'">CERTEZA</span>
              </div>
              <div class="relative w-full">
                <input type="number" min="10" max="95" step="1" :value="Math.round((status[status.activeProfileName].predictionThreshold || 0.70) * 100)" @change="status[status.activeProfileName].predictionThreshold = $event.target.value / 100; updateRiskSettings();" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-10 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none" :class="status.activeProfileName === 'standardConfig' ? 'focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/50' : 'focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/50'" />
                <span class="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-black pointer-events-none">%</span>
              </div>
              <input type="range" min="10" max="95" step="1" :value="Math.round((status[status.activeProfileName].predictionThreshold || 0.70) * 100)" @input="status[status.activeProfileName].predictionThreshold = $event.target.value / 100" @change="updateRiskSettings()" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer" :class="status.activeProfileName === 'standardConfig' ? 'accent-sky-500' : 'accent-orange-500'" />
            </div>

            <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors">
              <div class="flex justify-between items-center mb-4">
                <label class="text-[11px] text-zinc-400 font-bold uppercase tracking-widest whitespace-nowrap">Mínimo Edge</label>
                <span class="text-[9px] font-black px-2 py-1 rounded-md border shrink-0 whitespace-nowrap" :class="status.activeProfileName === 'standardConfig' ? 'text-sky-400 bg-sky-400/10 border-sky-400/20' : 'text-orange-400 bg-orange-400/10 border-orange-400/20'">VENTAJA</span>
              </div>
              <div class="relative w-full">
                <input type="number" min="2" max="30" step="1" :value="Math.round((status[status.activeProfileName].edgeThreshold || 0.08) * 100)" @change="status[status.activeProfileName].edgeThreshold = $event.target.value / 100; updateRiskSettings();" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-10 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none" :class="status.activeProfileName === 'standardConfig' ? 'focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/50' : 'focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/50'" />
                <span class="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-black pointer-events-none">%</span>
              </div>
              <input type="range" min="2" max="30" step="1" :value="Math.round((status[status.activeProfileName].edgeThreshold || 0.08) * 100)" @input="status[status.activeProfileName].edgeThreshold = $event.target.value / 100" @change="updateRiskSettings()" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer" :class="status.activeProfileName === 'standardConfig' ? 'accent-sky-500' : 'accent-orange-500'" />
            </div>

            <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors">
              <div class="flex justify-between items-center mb-4">
                <label class="text-[11px] text-zinc-400 font-bold uppercase tracking-widest whitespace-nowrap">Take Profit</label>
                <span class="text-[9px] font-black px-2 py-1 rounded-md border text-emerald-400 bg-emerald-400/10 border-emerald-400/20 shrink-0 whitespace-nowrap">GANANCIAS</span>
              </div>
              <div class="relative w-full">
                <input type="number" min="5" max="100" step="1" v-model.number="status[status.activeProfileName].takeProfitThreshold" @change="updateRiskSettings" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-10 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50" />
                <span class="absolute right-4 top-1/2 -translate-y-1/2 text-emerald-600 font-black pointer-events-none">%</span>
              </div>
              <input type="range" min="5" max="100" step="1" v-model.number="status[status.activeProfileName].takeProfitThreshold" @change="updateRiskSettings" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
            </div>

            <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors">
              <div class="flex justify-between items-center mb-4">
                <label class="text-[11px] text-zinc-400 font-bold uppercase tracking-widest whitespace-nowrap">Stop Loss</label>
                <span class="text-[9px] font-black px-2 py-1 rounded-md border text-rose-400 bg-rose-400/10 border-rose-400/20 shrink-0 whitespace-nowrap">PÉRDIDAS</span>
              </div>
              <div class="relative w-full">
                <input type="number" min="-90" max="-5" step="1" v-model.number="status[status.activeProfileName].stopLossThreshold" @change="updateRiskSettings" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-10 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/50" />
                <span class="absolute right-4 top-1/2 -translate-y-1/2 text-rose-600 font-black pointer-events-none">%</span>
              </div>
              <input type="range" min="-90" max="-5" step="1" v-model.number="status[status.activeProfileName].stopLossThreshold" @change="updateRiskSettings" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-rose-500" />
            </div>
          </div>
        </div>

        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-[0_0_50px_rgba(52,211,153,0.02)] hover:border-emerald-500/30">
          <div class="absolute -top-32 -right-32 w-64 h-64 bg-emerald-500 rounded-full blur-[100px] opacity-5 pointer-events-none transition-colors duration-700"></div>
          
          <div class="flex items-center justify-between mb-6 relative z-10 pb-6 border-b border-zinc-800/80">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border transition-colors duration-500 shadow-inner shrink-0 bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                <ShieldCheck :size="24" />
              </div>
              <div>
                <h3 class="text-white font-black text-lg tracking-tight">Filtros de Mercado</h3>
                <p class="text-xs text-zinc-500 font-medium">Bloqueo de sectores volátiles</p>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 relative z-10">
            <label v-for="key in filterOrder" :key="key" class="flex flex-col items-center justify-center p-4 rounded-2xl border cursor-pointer transition-all duration-300 relative overflow-hidden"
                  :class="status.marketFilters[key] ? 'bg-emerald-500/10 border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]' : 'bg-[#161619] border-zinc-800/60 hover:border-zinc-700'">
              <div v-if="status.marketFilters[key]" class="absolute top-0 w-full h-1 bg-emerald-500"></div>
              <span class="text-[11px] font-black uppercase tracking-widest mt-1" :class="status.marketFilters[key] ? 'text-emerald-400' : 'text-zinc-500'">{{ key }}</span>
              <input type="checkbox" v-model="status.marketFilters[key]" @change="updateFilters" class="sr-only">
            </label>
          </div>

          <div class="mt-6 pt-6 border-t border-zinc-800/80 relative z-10">
            <div class="flex items-center justify-between mb-4">
              <h4 class="text-[11px] font-black uppercase tracking-widest text-zinc-400">Límite: Deportes</h4>
              <span class="text-[10px] font-mono font-bold px-2.5 py-1 rounded-md transition-colors duration-300"
                    :class="status.maxActiveSportsMarkets === 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800/50 text-zinc-400 border border-zinc-700'">
                {{ status.maxActiveSportsMarkets === 0 ? 'MODO AUTO' : status.maxActiveSportsMarkets + ' MÁX' }}
              </span>
            </div>

            <div class="flex items-center gap-4">
              <input 
                type="range" 
                min="0" 
                max="20" 
                v-model.number="status.maxActiveSportsMarkets"
                @change="updateConfig" 
                class="flex-1 accent-emerald-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
              />
              <button 
                @click="status.maxActiveSportsMarkets = 0; updateConfig()"
                class="text-[10px] font-black tracking-widest px-4 py-2 rounded-xl transition-all duration-300"
                :class="status.maxActiveSportsMarkets === 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.1)]' : 'bg-[#161619] text-zinc-500 border border-zinc-800/60 hover:border-zinc-700 hover:text-zinc-300'"
              >
                AUTO
              </button>
            </div>
            
            <p class="text-[10px] text-zinc-500 mt-3 font-medium flex items-center gap-1.5">
              <span class="text-emerald-500/70 text-xs">*</span> 
              0 = Ilimitado. Activos ahora: 
              <strong class="text-zinc-300 font-mono bg-zinc-800/50 px-1.5 rounded">
                {{ status.activePositions ? status.activePositions.filter(p => p.category === 'SPORTS').length : 0 }}
              </strong>
            </p>
          </div>

        </div>

        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-[0_0_50px_rgba(16,185,129,0.02)] hover:border-emerald-500/30">
          <div class="absolute -top-32 -right-32 w-64 h-64 bg-emerald-500 rounded-full blur-[100px] opacity-10 pointer-events-none transition-colors duration-700"></div>
          <div class="absolute -right-6 -top-6 opacity-5 group-hover:opacity-10 transition-all duration-700 pointer-events-none">
            <Cpu :size="150" class="text-emerald-500" />
          </div>
          
          <div class="flex items-center justify-between mb-6 relative z-10 pb-6 border-b border-zinc-800/80">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border transition-colors duration-500 shadow-inner shrink-0 bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                <Cpu :size="24" />
              </div>
              <div>
                <h3 class="text-white font-black text-lg tracking-tight">Autopilot Sniper</h3>
                <p class="text-xs text-zinc-500 font-medium">Disparo Automático con IA</p>
              </div>
            </div>
            
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input type="checkbox" v-model="status.autoTradeEnabled" @change="updateAutoTrade" class="sr-only peer">
              <div class="w-11 h-6 bg-[#09090b] border border-zinc-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-emerald-500/20 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-400 after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 peer-checked:border-emerald-500 group-hover/toggle:shadow-[0_0_15px_rgba(16,185,129,0.3)]"></div>
            </label>
          </div>

          <div class="relative z-10 flex flex-col sm:flex-row items-center justify-between bg-[#161619] p-4 rounded-2xl border border-zinc-800/60 focus-within:border-emerald-500/50 transition-colors gap-4">
            <div class="flex flex-col w-full">
              <span class="text-[10px] text-zinc-500 font-black uppercase tracking-widest mb-2">Monto por Disparo</span>
              <div class="flex items-center relative w-full">
                <span class="absolute left-4 text-emerald-500 font-bold text-lg">$</span>
                <input 
                  type="number" v-model.number="status[status.activeProfileName].microBetAmount" @change="updateAutoTrade" min="0.5" step="0.5"
                  class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-9 pr-4 text-white font-mono text-xl font-bold outline-none transition-all placeholder-zinc-700 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed" 
                  :disabled="!status.autoTradeEnabled"
                />
              </div>
            </div>
            <div class="text-[10px] font-black flex justify-center items-center gap-2 uppercase border px-4 py-3 rounded-xl transition-all w-full sm:w-auto mt-2 sm:mt-0" 
                 :class="status.autoTradeEnabled ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]' : 'text-zinc-500 bg-[#09090b] border-zinc-800/80'">
              <div v-if="status.autoTradeEnabled" class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              <span>{{ status.autoTradeEnabled ? 'ARMADO' : 'SEGURO' }}</span>
            </div>
          </div>
        </div>

        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-[0_0_50px_rgba(168,85,247,0.02)] hover:border-purple-500/30">
          <div class="absolute -top-32 -right-32 w-64 h-64 bg-purple-500 rounded-full blur-[100px] opacity-10 pointer-events-none transition-colors duration-700"></div>

          <div class="flex items-center justify-between mb-8 relative z-10 pb-6 border-b border-zinc-800/80">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border transition-colors duration-500 shadow-inner shrink-0 bg-purple-500/10 border-purple-500/20 text-purple-400">
                <Target :size="24" />
              </div>
              <div>
                <h3 class="text-white font-black text-lg tracking-tight">Copy Trading</h3>
                <p class="text-xs text-zinc-500 font-medium">Copiar a las mejores whales</p>
              </div>
            </div>
            
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input type="checkbox" v-model="status.copyTradingEnabled" @change="updateCopyTrading" class="sr-only peer">
              <div class="w-11 h-6 bg-[#09090b] border border-zinc-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-purple-500/20 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-400 after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500 peer-checked:border-purple-500 group-hover/toggle:shadow-[0_0_15px_rgba(168,85,247,0.3)]"></div>
            </label>
          </div>

          <div v-if="status.copyTradingEnabled" class="relative z-10 space-y-6">
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              
              <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors">
                <div class="flex justify-between items-start mb-4 gap-2">
                  <label class="text-[10px] text-zinc-400 font-bold uppercase tracking-widest leading-snug">Tamaño Máximo</label>
                  <span class="text-[9px] font-black px-2 py-1 rounded-md border text-purple-400 bg-purple-400/10 border-purple-400/20 shrink-0">VOL.</span>
                </div>
                <div class="relative w-full mt-auto">
                  <input type="number" min="10" max="200" step="1" v-model.number="status.maxCopySize" @change="updateCopyTrading" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-12 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50" />
                  <span class="absolute right-4 top-1/2 -translate-y-1/2 text-purple-600/50 font-black pointer-events-none text-xs">SH</span>
                </div>
                <input type="range" min="10" max="200" step="1" v-model.number="status.maxCopySize" @change="updateCopyTrading" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-purple-500" />
              </div>

              <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors">
                <div class="flex justify-between items-start mb-4 gap-2">
                  <label class="text-[10px] text-zinc-400 font-bold uppercase tracking-widest leading-snug">Límite Balance</label>
                  <span class="text-[9px] font-black px-2 py-1 rounded-md border text-purple-400 bg-purple-400/10 border-purple-400/20 shrink-0">CAP.</span>
                </div>
                <div class="relative w-full mt-auto">
                  <input type="number" min="1" max="15" step="1" v-model.number="status[status.activeProfileName].maxCopyPercentOfBalance" @change="updateCopySettings" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-10 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50" />
                  <span class="absolute right-4 top-1/2 -translate-y-1/2 text-purple-600/50 font-black pointer-events-none">%</span>
                </div>
                <input type="range" min="1" max="15" step="1" v-model.number="status[status.activeProfileName].maxCopyPercentOfBalance" @change="updateCopySettings" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-purple-500" />
              </div>

              <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors md:col-span-2 xl:col-span-1">
                <div class="flex justify-between items-start mb-4 gap-2">
                  <label class="text-[10px] text-zinc-400 font-bold uppercase tracking-widest leading-snug">Top Whales</label>
                  <span class="text-[9px] font-black px-2 py-1 rounded-md border text-purple-400 bg-purple-400/10 border-purple-400/20 shrink-0">SEG.</span>
                </div>
                <div class="relative w-full mt-auto">
                  <input type="number" min="1" max="20" step="1" v-model.number="status.maxWhalesToCopy" @change="updateCopyTrading" class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-16 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50" />
                  <span class="absolute right-4 top-1/2 -translate-y-1/2 text-purple-600/50 font-black pointer-events-none text-xs">USERS</span>
                </div>
                <input type="range" min="1" max="20" step="1" v-model.number="status.maxWhalesToCopy" @change="updateCopyTrading" class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-purple-500" />
              </div>
            </div>

            <div class="pt-2">
              <p class="text-[11px] text-zinc-500 font-bold uppercase tracking-widest mb-3 px-1">Whales seleccionadas automáticamente</p>
              <div class="max-h-52 overflow-y-auto custom-scroll space-y-2 pr-2">
                <div v-for="(whale, i) in status.autoSelectedWhales || []" :key="i" class="bg-[#09090b] border border-zinc-800/80 rounded-xl p-3.5 flex justify-between items-center hover:border-purple-500/30 transition-colors group">
                  <div class="font-mono text-purple-400/80 text-xs font-medium group-hover:text-purple-400">{{ whale.address.substring(0,12) }}...</div>
                  <div class="flex gap-4 text-[10px] font-black tracking-wide">
                    <span class="text-emerald-500/80 bg-emerald-500/10 px-2 py-1 rounded-md border border-emerald-500/20">+${{ Number(whale.pnl || 0).toLocaleString(undefined, {maximumFractionDigits: 0}) }}</span>
                    <span class="text-zinc-500 bg-zinc-800/50 px-2 py-1 rounded-md border border-zinc-700/50 hidden sm:block">VOL: ${{ Number(whale.volume || 0).toLocaleString(undefined, {maximumFractionDigits: 0}) }}</span>
                  </div>
                </div>
                <div v-if="!status.autoSelectedWhales || status.autoSelectedWhales.length === 0" class="text-center py-6 border border-dashed border-zinc-800 rounded-xl text-zinc-500 text-xs font-medium">Esperando selección automática...</div>
              </div>
            </div>
          </div>

          <div v-else class="text-center py-10 bg-[#09090b] rounded-2xl border border-zinc-800/50 relative z-10 mt-6">
            <Target :size="32" class="text-zinc-700 mx-auto mb-3" />
            <p class="text-zinc-500 text-sm font-medium">Activa Copy Trading para seguir automáticamente a las mejores ballenas</p>
          </div>
        </div>

        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all shadow-lg hover:border-zinc-700/50">
          <h3 class="text-zinc-400 font-black text-xs uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
            <Activity :size="16" class="text-zinc-500" />
            Telemetría del Sistema
          </h3>
          
          <div class="space-y-3">
            <div class="flex justify-between items-center bg-[#161619] p-4 rounded-2xl border border-zinc-800/60">
              <span class="text-[10px] text-zinc-500 font-black uppercase tracking-widest">Conexión CLOB</span>
              <span class="text-xs font-mono font-bold text-emerald-400 flex items-center gap-2">
                <div class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div> EOA Active
              </span>
            </div>
            
            <div class="flex justify-between items-center bg-[#161619] p-4 rounded-2xl border border-zinc-800/60">
              <span class="text-[10px] text-zinc-500 font-black uppercase tracking-widest">Motor IA</span>
              <span class="text-[10px] font-mono font-bold text-[#D4AF37]">Claude + Gemini + Grok</span>
            </div>

            <div class="flex justify-between items-center bg-[#161619] p-4 rounded-2xl border border-zinc-800/60">
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