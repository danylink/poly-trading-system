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
  // 1. Variables Generales del Dashboard
  lastCheck: null,
  lastProbability: 0,
  currentMarket: { title: 'Cargando radar...' },
  lastNews: [],
  balanceUSDC: '0.00',
  balancePOL: '0.00',
  unclaimedUSDC: '0.00',
  executions: [],
  pendingSignals: [],
  activePositions: [],
  autoTradeEnabled: true,
  isPanicStopped: false,

  marketFilters: { 
    crypto: true, 
    politics: true, 
    business: true, 
    sports: false, 
    pop: false 
  },
  maxActiveSportsMarkets: 5,
  dailyLossLimit: 15,

  // 2. Copy Trading (NUEVA NOMENCLATURA)
  copyTradingCustomEnabled: false,   // ← Card Custom (tus ballenas)
  copyTradingAutoEnabled: false,     // ← Card Auto (leaderboard)
  
  maxWhalesToCopy: 5,
  autoSelectedWhales: [],
  customWhales: [],                  // ← Tus ballenas manuales
  copiedTrades: [],
  copiedPositions: [],
  copyTradingStats: { 
    totalCopied: 0, 
    successful: 0 
  },
  
  aiConfig: {
    standard: { predictionThreshold: 0.75, edgeThreshold: 0.11, takeProfitThreshold: 35, stopLossThreshold: -35, microBetAmount: 2 },
    volatile: { predictionThreshold: 0.88, edgeThreshold: 0.15, takeProfitThreshold: 25, stopLossThreshold: -30, microBetAmount: 0.5 }
  },
  whaleConfig: {
    standard: { takeProfitThreshold: 90, stopLossThreshold: -90, maxCopyPercentOfBalance: 8, maxCopySize: 50 },
    volatile: { takeProfitThreshold: 50, stopLossThreshold: -50, maxCopyPercentOfBalance: 2, maxCopySize: 10 }
  },

  // 4. Telemetría
  systemMetrics: {
    botRamMB: 0,
    serverTotalRamMB: 0,
    serverFreeRamMB: 0,
    uptimeHours: 0,
    cpuLoad: 0
  },

  riskSettings: {
    entrySlippage: 5,
    panicSlippage: 40,
    maxGasPrice: 1.5,
    tradeCooldownMin: 90
  },
  customMarketRules: [],

  // Variables para el formulario de nueva regla
  newRuleKeyword: '',
  newRuleTP: 25,
  newRuleSL: -30,
  newRuleBet: 2,
});

// --- CONTROL DE PESTAÑAS MÓVILES ---
const mobileActiveTab = ref('main');

// --- GESTIÓN DE RIESGO BIDIMENSIONAL ---
const riskSource = ref('ai'); // 'ai' o 'whale'
const riskCategory = ref('standard'); // 'standard' o 'volatile'

const currentRiskSettings = computed(() => {
  if (!status.value.aiConfig || !status.value.whaleConfig) return {};
  return riskSource.value === 'ai' 
    ? status.value.aiConfig[riskCategory.value] || {}
    : status.value.whaleConfig[riskCategory.value] || {};
});

const updateRiskSettings = async () => {
  try {
    await axios.post(`${API_URL}/settings/risk`, {
      source: riskSource.value,
      profile: riskCategory.value,
      settings: currentRiskSettings.value
    });
  } catch (error) {
    console.error("Error actualizando riesgo", error);
  }
};

// Arreglo maestro para forzar el orden visual de los filtros
const filterOrder = ['crypto', 'politics', 'business', 'sports', 'pop'];

// ==================== COPY TRADING - CUSTOM WHALES ====================
const newWhaleAddress = ref('');
const newWhaleNickname = ref('');

// Agregar ballena manual
const addCustomWhale = async () => {
  if (!newWhaleAddress.value.startsWith('0x') || newWhaleAddress.value.length !== 42) {
    Swal.fire('Error', 'Dirección inválida', 'error');
    return;
  }

  try {
    await axios.post(`${API_URL}/custom-whales`, {
      address: newWhaleAddress.value,
      nickname: newWhaleNickname.value
    }, {
      headers: { 
        'Authorization': authPassword.value || localStorage.getItem('poly_auth') 
      }
    });

    newWhaleAddress.value = '';
    newWhaleNickname.value = '';
    await fetchStatus();
    Swal.fire('Éxito', 'Ballena agregada correctamente', 'success');
  } catch (e) {
    Swal.fire('Error', e.response?.data?.error || 'No se pudo agregar la ballena', 'error');
  }
};

// Toggle individual de una ballena custom
const toggleCustomWhale = async (address) => {
  const whale = status.value.customWhales.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (!whale) return;

  try {
    await axios.post(`${API_URL}/custom-whales/toggle`, {
      address,
      enabled: whale.enabled
    }, {
      headers: { 
        'Authorization': authPassword.value || localStorage.getItem('poly_auth') 
      }
    });
  } catch (e) {
    console.error("Error al cambiar toggle de ballena:", e.response?.data || e.message);
  }
};

// Eliminar ballena custom
const deleteCustomWhale = async (address) => {
  if (!confirm('¿Eliminar esta ballena?')) return;

  try {
    await axios.delete(`${API_URL}/custom-whales`, {
      data: { address },
      headers: { 
        'Authorization': authPassword.value || localStorage.getItem('poly_auth') 
      }
    });
    await fetchStatus();
  } catch (e) {
    Swal.fire('Error', e.response?.data?.error || 'No se pudo eliminar', 'error');
  }
};


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
      // Usamos el microBetAmount de la IA (Standard) como valor global del switch
      amount: status.value.aiConfig?.standard?.microBetAmount || 1
    });
  } catch (error) {
    console.error("❌ Error actualizando AutoTrade");
  } finally {
    isAutoTradeUpdating.value = false;
  }
};

const executeManualTrade = async (signal) => {
  if (signal.loading) return;
  signal.loading = true;
  
  try {
    // 🔥 FIX: Detectamos la bala correcta según la categoría de la señal
    const isVolatile = signal.category === 'SPORTS' || signal.category === 'POP';
    const profileKey = isVolatile ? 'volatile' : 'standard';
    const betAmount = status.value.aiConfig?.[profileKey]?.microBetAmount || 1;

    const res = await axios.post(`${API_URL}/execute-trade`, {
      market: signal.marketName,
      amount: betAmount, 
      conditionId: signal.conditionId,
      tokenId: signal.tokenId,
      marketPrice: signal.marketPrice 
    });
    
    if (res.data.success) {
      status.value.pendingSignals = status.value.pendingSignals.filter(s => s.id !== signal.id);
      await fetchStatus(); 
    }
  } catch (error) {
    console.error("❌ Fallo en ejecución manual", error);
  } finally {
    signal.loading = false;
  }
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
    // 🔥 FIX: Usamos axios para que pase la validación de la Bóveda automáticamente
    const response = await axios.post(`${API_URL}/sell`, { 
      tokenId, 
      shares: exactSize 
    });

    if (response.data.success) {
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
      // Recargamos el dashboard al instante
      await fetchStatus(); 
    }
  } catch (error) {
    // 3. Alerta de Error (controlado por la API)
    Swal.fire({
      title: 'Disparo Fallido',
      text: error.response?.data?.error || 'No se pudo contactar al servidor. Revisa los logs en Toronto.',
      icon: 'error',
      background: '#1C1612',
      color: '#e4e4e7',
      iconColor: '#f43f5e', // Rojo rosa de tu diseño
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

// ====================== FUNCIÓN ÚNICA PARA COPY TRADING ======================
const updateCopyTrading = async () => {
  try {
    await axios.post(`${API_URL}/settings/copytrading`, {
      customEnabled: status.value.copyTradingCustomEnabled,
      autoEnabled: status.value.copyTradingAutoEnabled,
      maxWhalesToCopy: status.value.maxWhalesToCopy || 5
    }, {
      headers: { 
        'Authorization': authPassword.value || localStorage.getItem('poly_auth') 
      }
    });
    await fetchStatus();
  } catch (error) {
    console.error("❌ Error actualizando Copy Trading", error);
  }
};

// ====================== ACTUALIZAR FILTROS DE COPY TRADING ======================
const updateCopyFilters = async () => {
  try {
    await axios.post(`${API_URL}/settings/copy-filters`, {
      copyMinWhaleSize: status.value.copyMinWhaleSize,
      copyTimeWindowMinutes: status.value.copyTimeWindowMinutes
    });
    console.log(`📋 Filtros de Copy Trading actualizados`);
  } catch (error) {
    console.error("❌ Error actualizando filtros de copy trading", error);
    Swal.fire('Error', 'No se pudieron guardar los filtros', 'error');
  }
};

// ====================== ACTUALIZAR LÍMITE POR BALLENA ======================
const updateCopyLimitPerWhale = async () => {
  try {
    await axios.post(`${API_URL}/settings/copy-limit-per-whale`, {
      maxCopyMarketsPerWhale: status.value.maxCopyMarketsPerWhale
    });
    console.log(`📋 Límite por ballena actualizado a: ${status.value.maxCopyMarketsPerWhale}`);
  } catch (error) {
    console.error("❌ Error actualizando límite por ballena", error);
    Swal.fire('Error', 'No se pudo actualizar el límite', 'error');
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
      maxActiveSportsMarkets: status.value.maxActiveSportsMarkets,
      dailyLossLimit: status.value.dailyLossLimit // 🔥 NUEVO DATO ENVIADO
    });
    console.log(`✅ Configuración actualizada`);
  } catch (error) {
    console.error("❌ Error actualizando configuración", error);
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

// Variable reactiva para el efecto visual del botón "Copiado"
const isCopied = ref(false);

// Función para formatear y copiar el log al portapapeles
const copyLogsToClipboard = async () => {
  if (!systemLogs.value || systemLogs.value.length === 0) return;

  // Transformar los logs en texto puro
  const logText = systemLogs.value.map(log => {
    let icon = '> ';
    if (log.type === 'error') icon = '❌ ';
    else if (log.message && log.message.includes('🎯')) icon = '';
    return `[${log.time}] ${icon}${log.message}`;
  }).join('\n');

  // PLAN A: Método Moderno (Solo funciona si tienes HTTPS o localhost)
  if (window.isSecureContext && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(logText);
      isCopied.value = true;
      setTimeout(() => isCopied.value = false, 2000);
      return; // Salimos si fue exitoso
    } catch (err) {
      console.warn('API moderna bloqueada. Usando Fallback...');
    }
  }

  // PLAN B: Fallback Clásico (Para IPs locales http://192.168... en celular)
  const textArea = document.createElement("textarea");
  textArea.value = logText;
  // Lo hacemos completamente invisible para no romper el diseño visual
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.opacity = "0";
  
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    const successful = document.execCommand('copy');
    if (successful) {
      isCopied.value = true;
      setTimeout(() => isCopied.value = false, 2000);
    } else {
      Swal.fire('Error', 'Tu navegador móvil bloqueó el copiado', 'error');
    }
  } catch (err) {
    console.error('Fallback falló:', err);
    Swal.fire('Error', 'No se pudo copiar el log', 'error');
  }
  document.body.removeChild(textArea);
};

const updateQuantumRiskSettings = async () => {
  try {
    const response = await axios.post(`${API_URL}/settings/advanced-risk`, status.value.riskSettings);
    if (response.data.success) {
      Swal.fire({
        title: '¡Protocolo Actualizado!',
        text: 'Los parámetros de riesgo han sido sincronizados con el motor Quant.',
        icon: 'success',
        background: '#1C1612',
        color: '#e4e4e7',
        iconColor: '#D4AF37',
        confirmButtonColor: '#D4AF37',
        confirmButtonText: 'ENTENDIDO',
        customClass: { popup: 'border border-[#D4AF37]/30 rounded-2xl' }
      });
    }
  } catch (error) {
    console.error("Error sincronizando riesgo:", error);
    Swal.fire({
      title: 'Error de Sincronización',
      text: 'No se pudo contactar con el núcleo del bot.',
      icon: 'error',
      background: '#1C1612',
      color: '#e4e4e7',
      confirmButtonColor: '#f43f5e'
    });
  }
};

// ====================== REGLAS PERSONALIZADAS POR MERCADO ======================
const addCustomRule = async () => {
  if (!status.value.newRuleKeyword.trim()) {
    Swal.fire('Error', 'Debes escribir un keyword', 'error');
    return;
  }

  try {
    await axios.post(`${API_URL}/settings/custom-rules`, {
      keyword: status.value.newRuleKeyword.trim(),
      takeProfitThreshold: status.value.newRuleTP,
      stopLossThreshold: status.value.newRuleSL,
      microBetAmount: status.value.newRuleBet   // ← NUEVO
    });

    // Limpiar formulario
    status.value.newRuleKeyword = '';
    status.value.newRuleTP = 25;
    status.value.newRuleSL = -30;
    status.value.newRuleBet = 2;

    await fetchStatus();
    Swal.fire('¡Regla agregada!', 'Se aplicará automáticamente', 'success');
  } catch (error) {
    Swal.fire('Error', error.response?.data?.error || 'No se pudo agregar', 'error');
  }
};

const deleteCustomRule = async (keyword) => {
  if (!confirm(`¿Eliminar la regla para "${keyword}"?`)) return;

  try {
    await axios.delete(`${API_URL}/settings/custom-rules`, {
      data: { keyword }
    });
    await fetchStatus();
  } catch (error) {
    Swal.fire('Error', 'No se pudo eliminar la regla', 'error');
  }
};

const saveEditedRule = async (index) => {
  try {
    const rule = status.value.customMarketRules[index];
    
    await axios.post(`${API_URL}/settings/custom-rules`, {
      keyword: rule.keyword,
      takeProfitThreshold: rule.takeProfitThreshold,
      stopLossThreshold: rule.stopLossThreshold,
      microBetAmount: rule.microBetAmount
    });

    await fetchStatus();
    Swal.fire('¡Regla actualizada!', '', 'success');
  } catch (error) {
    Swal.fire('Error', 'No se pudo guardar los cambios', 'error');
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

// 2. Cartera Total (Efectivo libre + Valor de posiciones activas + Dinero por reclamar)
const totalCartera = computed(() => {
  const cash = parseFloat(status.value.clobOnlyUSDC || status.value.balanceUSDC || 0);
  const unclaimed = parseFloat(status.value.unclaimedUSDC || 0);
  return (cash + activePortfolioValue.value + unclaimed).toFixed(2);
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

    <main class="max-w-[1600px] mx-auto grid grid-cols-12 gap-8 relative px-4 xl:px-8 mt-8">
      
      <div class="col-span-12 xl:hidden flex bg-[#111114]/95 p-1.5 rounded-2xl border border-zinc-800/80 sticky top-4 z-50 backdrop-blur-xl shadow-2xl mb-4">
        <button 
          @click="mobileActiveTab = 'main'"
          :class="mobileActiveTab === 'main' ? 'bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 shadow-[0_0_15px_rgba(212,175,55,0.1)]' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'"
          class="flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 flex items-center justify-center gap-2">
          <Activity :size="16" /> Operaciones
        </button>
        <button 
          @click="mobileActiveTab = 'system'"
          :class="mobileActiveTab === 'system' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]' : 'text-zinc-500 hover:text-zinc-300 border border-transparent'"
          class="flex-1 py-3.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 flex items-center justify-center gap-2">
          <Server :size="16" /> Sistema
        </button>
      </div>

      <div class="col-span-12 xl:col-span-8 space-y-8" :class="mobileActiveTab === 'main' ? 'block' : 'hidden xl:block'">
        
        <!-- ====================== ESTADO DE CUENTA SECTION ====================== -->
        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 mb-8 transition-all duration-500 relative overflow-hidden shadow-lg hover:border-[#D4AF37]/30 group">
          <div class="absolute -top-32 -left-32 w-64 h-64 bg-[#D4AF37] rounded-full blur-[120px] opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity duration-700"></div>
          
          <div class="flex items-center justify-between mb-8 pb-4 border-b border-zinc-800/50 relative z-10">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border bg-[#D4AF37]/10 border-[#D4AF37]/20 text-[#D4AF37] shadow-inner shrink-0">
                <Activity :size="24" />
              </div>
              <div>
                <h2 class="text-xl font-black text-white tracking-tight">Estado de Cuenta</h2>
                <p class="text-xs text-zinc-500 font-medium">Balance global y métricas de rendimiento</p>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-5 relative z-10"> 
            
            <div class="bg-[#1c1917] border-2 border-[#D4AF37] p-5 rounded-3xl shadow-[0_0_20px_rgba(212,175,55,0.2)] relative overflow-hidden group flex flex-col justify-center">
              <div class="absolute -right-6 -top-6 opacity-10"><Target :size="80" class="text-[#D4AF37]" /></div>
              <p class="text-[10px] uppercase font-black text-[#D4AF37] tracking-widest mb-1">Cartera Total</p>
              <div class="flex items-baseline gap-1">
                <h3 class="text-4xl font-extrabold text-white font-mono">${{ totalCartera }}</h3>
              </div>
              <p class="text-[9px] text-zinc-400 mt-2 font-bold uppercase tracking-tighter flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-[#D4AF37] animate-pulse"></span> Valor total de la cuenta
              </p>
              
              <div v-if="parseFloat(status.unclaimedUSDC) > 0" class="mt-3 flex items-center justify-between bg-blue-500/10 border border-blue-500/30 px-3 py-1.5 rounded-xl">
                <span class="text-[9px] font-black uppercase tracking-widest text-blue-400">Por Reclamar</span>
                <span class="text-xs font-mono font-bold text-blue-400">+${{ status.unclaimedUSDC }}</span>
              </div>
            </div>

            <div class="bg-[#09090b] border border-zinc-800/80 p-5 rounded-2xl flex flex-col justify-center hover:border-zinc-700 transition-all">
              <p class="text-[10px] uppercase font-black text-zinc-500 tracking-widest mb-1">Disponible (Polymarket)</p>
              <div class="flex items-baseline gap-1">
                <h3 class="text-3xl font-bold text-zinc-200 font-mono">${{ status.clobOnlyUSDC || status.balanceUSDC }}</h3>
                <span class="text-[10px] text-zinc-600 font-bold">USDC</span>
              </div>
              <p class="text-[9px] text-zinc-500 mt-2 font-bold uppercase tracking-tighter">Efectivo libre operativo</p>
            </div>

            <div class="bg-[#09090b] border border-zinc-800/80 p-5 rounded-2xl relative overflow-hidden flex flex-col justify-center hover:border-zinc-700 transition-all">
              <p class="text-[10px] uppercase font-black tracking-widest mb-1 flex items-center gap-1"
                 :class="floatingPnL >= 0 ? 'text-emerald-500/70' : 'text-rose-500/70'">
                 <Activity :size="12" /> PnL Flotante
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

            <div class="bg-[#09090b] border border-zinc-800/80 p-5 rounded-2xl hover:border-blue-900/50 transition-all flex flex-col justify-center">
              <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">MetaMask Wallet</p>
              <div class="flex items-baseline gap-1">
                <h3 class="text-2xl font-bold text-zinc-200 font-mono">${{ status.walletOnlyUSDC }}</h3>
                <span class="text-[10px] text-zinc-600 font-bold">USDC</span>
              </div>
              <p class="text-[9px] text-blue-500/70 mt-2 font-bold uppercase tracking-tighter flex items-center gap-1"><ArrowUpRight :size="10" /> Fondos en reserva</p>
            </div>

            <div class="bg-[#09090b] border border-zinc-800/80 p-5 rounded-2xl flex flex-col justify-center hover:border-zinc-700 transition-all">
              <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">Gas Network</p>
              <div class="flex items-baseline gap-1">
                <h3 class="text-2xl font-bold text-zinc-200 font-mono">{{ status.balancePOL }}</h3>
                <span class="text-[10px] text-zinc-600 font-bold">POL</span>
              </div>
            </div>

            <div class="bg-[#09090b] border border-zinc-800/80 p-5 rounded-2xl flex flex-col justify-center hover:border-[#D4AF37]/30 transition-all">
              <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">IA Confidence</p>
              <h3 class="text-2xl font-bold font-mono" :class="probColor">{{ (status.lastProbability * 100).toFixed(1) }}%</h3>
            </div>

          </div>
        </div>

        <!-- ====================== POSICIONES EN VIVO SECTION ====================== -->
        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 mb-8 transition-all duration-500 relative overflow-hidden shadow-lg hover:border-emerald-500/30 group">
          <div class="absolute -bottom-32 -right-32 w-64 h-64 bg-emerald-500 rounded-full blur-[120px] opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity duration-700"></div>

          <div class="flex items-center justify-between mb-8 pb-6 border-b border-zinc-800/50 relative z-10">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 shadow-inner relative shrink-0">
                <div class="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full animate-ping"></div>
                <div class="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full"></div>
                <Activity :size="24" />
              </div>
              <div>
                <h2 class="text-xl font-black text-white tracking-tight">Posiciones en Vivo</h2>
                <p class="text-xs text-zinc-500 font-medium">Mercados operados on-chain</p>
              </div>
            </div>
            <div class="hidden sm:block text-[10px] font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-lg border border-emerald-500/20">
              {{ status.activePositions ? status.activePositions.length : 0 }} Activas
            </div>
          </div>
          
          <div class="grid grid-cols-1 gap-4 relative z-10">
            <div v-for="pos in status.activePositions" :key="pos.tokenId" 
                 class="bg-[#09090b] border border-zinc-800/80 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row justify-between items-start md:items-center shadow-inner hover:border-[#D4AF37]/50 transition-all">
              
              <div class="flex flex-col w-full md:w-1/2 pr-0 md:pr-4">
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-[9px] text-zinc-400 font-black uppercase tracking-widest px-2 py-0.5 bg-zinc-800/80 rounded-md border border-zinc-700/80">
                    {{ pos.category || 'MERCADO' }}
                  </span>
                  <span v-if="pos.outcome && pos.outcome !== 'N/A'" 
                        :class="pos.outcome === 'YES' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-rose-400 border-rose-500/30 bg-rose-500/10'"
                        class="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border shadow-inner">
                    {{ pos.outcome }}
                  </span>
                </div>
                <span class="text-zinc-200 font-bold text-sm line-clamp-2" :title="pos.marketName">{{ pos.marketName }}</span>
                <span class="text-[#D4AF37] font-mono text-[10px] mt-1">{{ pos.size }} Acciones</span>
              </div>

              <div class="flex items-center w-full md:w-auto justify-between md:justify-end gap-4 mt-4 md:mt-0 pt-4 md:pt-0 border-t border-zinc-800/50 md:border-0">
                
                <div class="text-left md:text-right hidden lg:block">
                  <span class="text-[9px] text-zinc-500 block uppercase font-black tracking-widest mb-0.5">Estado</span>
                  <span class="font-mono font-bold text-[10px]" :class="pos.status.includes('CANJEAR') ? 'text-zinc-500' : 'text-emerald-400'">
                    {{ pos.status }}
                  </span>
                </div>

                <div class="text-left md:text-right flex flex-col justify-center min-w-[80px]">
                  <span class="text-[9px] text-zinc-500 block uppercase font-black tracking-widest mb-0.5">Valor</span>
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
                        class="px-4 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all flex items-center justify-center gap-2 disabled:opacity-50 border shrink-0"
                        :class="pos.status.includes('CANJEAR') 
                          ? 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 hover:text-white' 
                          : ((pos.cashPnl || 0) >= 0 
                              ? 'bg-emerald-500/10 hover:bg-emerald-500 text-emerald-500 hover:text-white border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]' 
                              : 'bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white border-rose-500/30 shadow-[0_0_15px_rgba(244,63,94,0.1)]')">
                  
                  <span v-if="isSelling[pos.tokenId]" class="w-2 h-2 rounded-full animate-ping" 
                        :class="pos.status.includes('CANJEAR') ? 'bg-zinc-400' : ((pos.cashPnl || 0) >= 0 ? 'bg-emerald-400' : 'bg-rose-400')"></span>
                  
                  {{ isSelling[pos.tokenId] ? 'PROCESANDO...' : (pos.status.includes('CANJEAR') ? 'CANJEAR' : 'VENDER TODO') }}
                </button>
              </div>
            </div>

            <div v-if="!status.activePositions || status.activePositions.length === 0" 
                 class="bg-[#09090b]/50 border border-zinc-800/80 border-dashed rounded-2xl p-10 text-center flex flex-col items-center justify-center">
                 <Target :size="32" class="text-zinc-700 mb-3" />
                 <p class="text-zinc-500 text-sm font-medium">El escáner de red está activo. No hay posiciones operando.</p>
            </div>
          </div>
        </div>

        <!-- ====================== SEÑALES MULTI-AGENTE SECTION ====================== -->
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

        <!-- ====================== OPERACIONES COPY TRADING WHALES SECTION ====================== -->
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

        <!-- ====================== HISTORIAL DE EJECUCIONES SECTION ====================== -->
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

        <!-- ====================== RADAR DE INTELIGENCIA SECTION ====================== -->
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

        <!-- ====================== REGLAS PERSONALIZADAS POR MERCADO (Versión Editable Corregida) ====================== -->
         <div class="bg-[#111114] border-2 border-amber-500/20 rounded-3xl p-8 mb-8 relative overflow-hidden shadow-[0_0_40px_rgba(245,158,11,0.05)] hover:border-amber-500/40 transition-colors">
          <div class="absolute -right-20 -bottom-20 w-64 h-64 bg-amber-500 rounded-full blur-[120px] opacity-5 pointer-events-none"></div>
          
          <div class="flex items-center gap-4 mb-8 pb-4 border-b border-zinc-800/50 relative z-10">
            <div class="p-3.5 rounded-2xl border bg-amber-500/10 border-amber-500/20 text-amber-400 shadow-inner">
              <Target :size="24" />
            </div>
            <div>
              <h3 class="text-white font-black text-xl tracking-tight">Reglas Personalizadas</h3>
              <p class="text-xs text-zinc-500 font-medium">Control quirúrgico de Take Profit y Stop Loss por Keyword</p>
            </div>
          </div>

          <div class="grid grid-cols-1 xl:grid-cols-12 gap-8 relative z-10">
            
            <div class="xl:col-span-5 bg-[#09090b] border border-amber-500/10 rounded-2xl p-6 h-fit">
              <h4 class="text-amber-500 text-[10px] font-black uppercase tracking-widest mb-4">Nueva Regla</h4>
              
              <div class="space-y-4">
                <div>
                  <label class="text-[9px] font-black uppercase text-zinc-400 tracking-widest block mb-1.5">Keyword del mercado</label>
                  <input 
                    v-model="status.newRuleKeyword" 
                    placeholder="Ej: Trump say, Temperature in..."
                    class="w-full bg-black border border-amber-500/20 rounded-xl px-4 py-3 text-sm font-mono focus:border-amber-400 outline-none transition-colors"
                  >
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="text-[9px] font-black uppercase text-emerald-400 tracking-widest block mb-1.5">Take Profit</label>
                    <div class="flex items-center gap-2 bg-black border border-emerald-500/20 rounded-xl px-3 py-2.5">
                      <input type="number" v-model.number="status.newRuleTP" class="w-full min-w-0 bg-transparent font-mono text-emerald-400 text-lg text-right outline-none">
                      <span class="text-emerald-400 font-bold shrink-0">%</span>
                    </div>
                  </div>
                  <div>
                    <label class="text-[9px] font-black uppercase text-rose-400 tracking-widest block mb-1.5">Stop Loss</label>
                    <div class="flex items-center gap-2 bg-black border border-rose-500/20 rounded-xl px-3 py-2.5">
                      <input type="number" v-model.number="status.newRuleSL" class="w-full min-w-0 bg-transparent font-mono text-rose-400 text-lg text-right outline-none">
                      <span class="text-rose-400 font-bold shrink-0">%</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label class="text-[9px] font-black uppercase text-[#D4AF37] tracking-widest block mb-1.5">Tamaño Apuesta (USDC)</label>
                  <input 
                    type="number" 
                    v-model.number="status.newRuleBet" 
                    min="0.5" max="50" step="0.5"
                    class="w-full bg-black border border-[#D4AF37]/20 rounded-xl px-4 py-3 text-lg font-mono text-[#D4AF37] text-center outline-none"
                  >
                </div>
              </div>

              <button 
                @click="addCustomRule" 
                class="mt-5 w-full bg-amber-500/10 hover:bg-amber-500 text-amber-500 hover:text-white border border-amber-500/30 font-black py-3 rounded-xl text-xs tracking-widest transition-all">
                AGREGAR REGLA
              </button>
            </div>

            <div class="xl:col-span-7">
              <h4 class="text-zinc-500 text-[10px] font-black uppercase tracking-widest mb-4">Reglas Activas</h4>
              
              <div v-if="status.customMarketRules && status.customMarketRules.length > 0" class="max-h-[400px] overflow-y-auto custom-scroll pr-2 space-y-3">
                
                <div v-for="(rule, index) in status.customMarketRules" :key="index"
                     class="bg-[#161619] border border-zinc-700/80 rounded-2xl p-4 hover:border-amber-500/30 transition-colors">
                  
                  <div class="flex flex-col sm:flex-row gap-4 mb-3">
                    <div class="flex-1">
                      <label class="text-[9px] font-black uppercase text-amber-500 tracking-widest block mb-1">Keyword</label>
                      <input 
                        v-model="rule.keyword"
                        class="w-full bg-black border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:border-amber-500 outline-none"
                      >
                    </div>
                    <div class="w-full sm:w-24">
                      <label class="text-[9px] font-black uppercase text-[#D4AF37] tracking-widest block mb-1">Apuesta</label>
                      <input 
                        type="number" v-model.number="rule.microBetAmount" min="0.5" step="0.5"
                        class="w-full bg-black border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-[#D4AF37] text-center outline-none"
                      >
                    </div>
                  </div>

                  <div class="grid grid-cols-2 gap-3 mb-4">
                    <div>
                      <div class="flex items-center gap-2 bg-black border border-zinc-800 rounded-lg px-3 py-1.5 focus-within:border-emerald-500/50">
                        <span class="text-[8px] font-black uppercase text-emerald-500 w-6">TP</span>
                        <input type="number" v-model.number="rule.takeProfitThreshold" class="w-full min-w-0 bg-transparent font-mono text-emerald-400 text-sm text-right outline-none">
                        <span class="text-emerald-500 font-bold text-xs shrink-0">%</span>
                      </div>
                    </div>
                    <div>
                      <div class="flex items-center gap-2 bg-black border border-zinc-800 rounded-lg px-3 py-1.5 focus-within:border-rose-500/50">
                        <span class="text-[8px] font-black uppercase text-rose-500 w-6">SL</span>
                        <input type="number" v-model.number="rule.stopLossThreshold" class="w-full min-w-0 bg-transparent font-mono text-rose-400 text-sm text-right outline-none">
                        <span class="text-rose-500 font-bold text-xs shrink-0">%</span>
                      </div>
                    </div>
                  </div>

                  <div class="flex justify-end gap-2 pt-3 border-t border-zinc-800/50">
                    <button 
                      @click="saveEditedRule(index)"
                      class="px-4 py-1.5 text-[9px] font-black uppercase tracking-widest bg-zinc-800 hover:bg-emerald-500/20 text-zinc-300 hover:text-emerald-400 border border-transparent hover:border-emerald-500/30 rounded-lg transition-all">
                      Guardar
                    </button>
                    <button 
                      @click="deleteCustomRule(rule.keyword)"
                      class="px-4 py-1.5 text-[9px] font-black uppercase tracking-widest bg-zinc-800 hover:bg-rose-500/20 text-zinc-300 hover:text-rose-400 border border-transparent hover:border-rose-500/30 rounded-lg transition-all">
                      Borrar
                    </button>
                  </div>
                </div>

              </div>

              <div v-else class="h-full min-h-[250px] flex flex-col items-center justify-center text-center p-8 border border-dashed border-zinc-800 rounded-2xl bg-[#09090b]/50">
                <Target :size="32" class="text-zinc-700 mb-3" />
                <p class="text-zinc-500 text-sm font-medium">Aún no tienes reglas específicas.</p>
                <p class="text-zinc-600 text-xs mt-1">Usa el formulario de la izquierda para agregar excepciones al mercado.</p>
              </div>
            </div>

          </div>
        </div>

      </div>

      <div class="col-span-12 xl:col-span-4 h-full space-y-6" :class="mobileActiveTab === 'system' ? 'block' : 'hidden xl:block'">
      
        <!-- ====================== LIVE TERMINAL SECTION ====================== -->
        <div class="bg-[#0a0a0a] border border-[#D4AF37]/30 rounded-3xl p-5 shadow-2xl mt-8">
          <div class="flex justify-between items-center mb-4 border-b border-[#D4AF37]/20 pb-3">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <h3 class="text-[10px] text-[#D4AF37] font-black uppercase tracking-[0.2em]">Live Terminal</h3>
            </div>
            
            <div class="flex items-center gap-2">
              <button 
                @click="copyLogsToClipboard" 
                :class="isCopied ? 'text-emerald-400 border-emerald-500/50' : 'text-zinc-400 hover:text-[#D4AF37] border-zinc-800 hover:border-[#D4AF37]/50'"
                class="text-[10px] uppercase tracking-widest font-bold transition-all duration-300 border px-3 py-1 rounded-lg flex items-center justify-center min-w-[75px]"
              >
                {{ isCopied ? '✅ Copiado' : '📋 Copiar' }}
              </button>
              
              <button 
                @click="fetchLogs" 
                class="text-[10px] text-zinc-400 hover:text-[#D4AF37] uppercase tracking-widest font-bold transition-colors border border-zinc-800 hover:border-[#D4AF37]/50 px-3 py-1 rounded-lg"
              >
                Actualizar
              </button>
            </div>
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

        <!-- ====================== TELEMETRIA DEL SISTEMA SECTION ====================== -->
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

        <!-- ====================== GESTION DE RIESGO SECTION ====================== -->
        <div v-if="status.aiConfig && status.whaleConfig" class="bg-[#111114] border border-[#D4AF37]/30 rounded-[2rem] p-6 lg:p-8 transition-all shadow-2xl mb-8 relative overflow-hidden group">
          <div class="absolute -right-20 -top-20 w-64 h-64 bg-[#D4AF37] rounded-full blur-[100px] opacity-5 pointer-events-none"></div>
          <div class="flex items-center gap-3 mb-6 pb-4 border-b border-zinc-800/80 relative z-10">
            <div class="p-2.5 bg-[#D4AF37]/10 rounded-xl border border-[#D4AF37]/20"><ShieldCheck :size="22" class="text-[#D4AF37]" /></div>
            <div>
              <h3 class="text-white font-black text-lg tracking-tight">Gestión de Riesgo Avanzada</h3>
              <p class="text-[10px] text-zinc-500 uppercase tracking-widest mt-0.5">Control separado por Origen y Categoría</p>
            </div>
          </div>

          <div class="flex gap-2 mb-4 bg-[#09090b] p-1.5 rounded-2xl border border-zinc-800/80 relative z-10">
            <button @click="riskSource = 'ai'" :class="riskSource === 'ai' ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/30 shadow-[0_0_10px_rgba(212,175,55,0.1)]' : 'text-zinc-500 border-transparent'" class="flex-1 py-3 rounded-xl text-xs font-black uppercase tracking-widest border transition-all flex items-center justify-center gap-2">
              <Cpu :size="16" /> Modelos de IA
            </button>
            <button @click="riskSource = 'whale'" :class="riskSource === 'whale' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30 shadow-[0_0_10px_rgba(168,85,247,0.1)]' : 'text-zinc-500 border-transparent'" class="flex-1 py-3 rounded-xl text-xs font-black uppercase tracking-widest border transition-all flex items-center justify-center gap-2">
              <Target :size="16" /> Copy Trading
            </button>
          </div>

          <div class="flex gap-2 mb-8 relative z-10">
            <button @click="riskCategory = 'standard'" :class="riskCategory === 'standard' ? 'text-white border-zinc-600 bg-zinc-800 shadow-inner' : 'text-zinc-500 border-zinc-800/50 bg-zinc-900/50 hover:bg-zinc-800/80'" class="flex-1 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all">
              📘 Estándar (Cripto/Pol)
            </button>
            <button @click="riskCategory = 'volatile'" :class="riskCategory === 'volatile' ? 'text-white border-zinc-600 bg-zinc-800 shadow-inner' : 'text-zinc-500 border-zinc-800/50 bg-zinc-900/50 hover:bg-zinc-800/80'" class="flex-1 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all">
              🌶️ Volátil (Pop/Deportes)
            </button>
          </div>

          <div class="grid grid-cols-1 gap-5 relative z-10">
            
            <template v-if="riskSource === 'ai'">
              <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
                <div class="flex justify-between items-center mb-2">
                  <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Balas por Disparo</label>
                  <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-blue-400 bg-blue-500/10 border-blue-500/40">USDC</span>
                </div>
                <div class="flex items-center gap-4">
                  <input type="range" min="0.5" max="50" step="0.5" v-model.number="currentRiskSettings.microBetAmount" @change="updateRiskSettings" class="flex-1 accent-blue-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                  <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-zinc-700 rounded-xl px-3 py-2">
                    <span class="text-zinc-500 font-bold text-sm">$</span>
                    <input type="number" min="0.5" max="50" step="0.5" v-model.number="currentRiskSettings.microBetAmount" @change="updateRiskSettings" class="w-full bg-transparent text-white font-mono text-base text-right outline-none" />
                  </div>
                </div>
              </div>

              <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
                <div class="flex justify-between items-center mb-2">
                  <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Filtro Sens. (IA)</label>
                  <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border" :class="(currentRiskSettings.predictionThreshold || 0) >= 0.75 ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40' : (currentRiskSettings.predictionThreshold || 0) <= 0.40 ? 'text-rose-500 bg-rose-500/10 border-rose-500/40' : 'text-[#D4AF37] bg-[#D4AF37]/10 border-[#D4AF37]/40'">
                    {{ (currentRiskSettings.predictionThreshold || 0) >= 0.75 ? 'MODO SEGURO' : ((currentRiskSettings.predictionThreshold || 0) <= 0.40 ? 'ALTO RIESGO' : 'ESTÁNDAR') }}
                  </span>
                </div>
                <div class="flex items-center gap-4">
                  <input type="range" min="10" max="100" step="1" :value="Math.round((currentRiskSettings.predictionThreshold || 0) * 100)" @input="currentRiskSettings.predictionThreshold = $event.target.value / 100" @change="updateRiskSettings" class="flex-1 accent-[#D4AF37] h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                  <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-zinc-700 rounded-xl px-3 py-2">
                    <input type="number" min="10" max="100" step="1" :value="Math.round((currentRiskSettings.predictionThreshold || 0) * 100)" @change="currentRiskSettings.predictionThreshold = $event.target.value / 100; updateRiskSettings()" class="w-full bg-transparent text-white font-mono text-base text-right outline-none" />
                    <span class="text-[#D4AF37] font-bold text-sm">%</span>
                  </div>
                </div>
              </div>

              <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
                <div class="flex justify-between items-center mb-2">
                  <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Mínimo Edge</label>
                  <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border" :class="(currentRiskSettings.edgeThreshold || 0) >= 0.12 ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40' : (currentRiskSettings.edgeThreshold || 0) <= 0.05 ? 'text-rose-500 bg-rose-500/10 border-rose-500/40' : 'text-[#D4AF37] bg-[#D4AF37]/10 border-[#D4AF37]/40'">
                    {{ (currentRiskSettings.edgeThreshold || 0) >= 0.12 ? 'CONSERVADOR' : ((currentRiskSettings.edgeThreshold || 0) <= 0.05 ? 'FRANCOTIRADOR' : 'ESTÁNDAR') }}
                  </span>
                </div>
                <div class="flex items-center gap-4">
                  <input type="range" min="1" max="50" step="1" :value="Math.round((currentRiskSettings.edgeThreshold || 0) * 100)" @input="currentRiskSettings.edgeThreshold = $event.target.value / 100" @change="updateRiskSettings" class="flex-1 accent-[#D4AF37] h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                  <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-zinc-700 rounded-xl px-3 py-2">
                    <input type="number" min="1" max="50" step="1" :value="Math.round((currentRiskSettings.edgeThreshold || 0) * 100)" @change="currentRiskSettings.edgeThreshold = $event.target.value / 100; updateRiskSettings()" class="w-full bg-transparent text-white font-mono text-base text-right outline-none" />
                    <span class="text-[#D4AF37] font-bold text-sm">%</span>
                  </div>
                </div>
              </div>
            </template>

            <template v-if="riskSource === 'whale'">
              <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-purple-500/20 bg-[#161619] relative overflow-hidden">
                <div class="flex justify-between items-center mb-2">
                  <label class="text-[10px] sm:text-xs text-purple-400 font-black uppercase tracking-[0.2em]">Tamaño Máximo</label>
                  <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-purple-400 bg-purple-500/10 border-purple-500/40">ACCIONES</span>
                </div>
                <div class="flex items-center gap-4">
                  <input type="range" min="1" max="500" step="1" v-model.number="currentRiskSettings.maxCopySize" @change="updateRiskSettings" class="flex-1 accent-purple-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                  <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-purple-900/50 rounded-xl px-3 py-2">
                    <input type="number" min="1" v-model.number="currentRiskSettings.maxCopySize" @change="updateRiskSettings" class="w-full bg-transparent text-white font-mono text-base text-right outline-none" />
                  </div>
                </div>
              </div>

              <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-purple-500/20 bg-[#161619] relative overflow-hidden">
                <div class="flex justify-between items-center mb-2">
                  <label class="text-[10px] sm:text-xs text-purple-400 font-black uppercase tracking-[0.2em]">Límite Balance</label>
                  <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-amber-400 bg-amber-500/10 border-amber-500/40">PROTECCIÓN</span>
                </div>
                <div class="flex items-center gap-4">
                  <input type="range" min="1" max="100" step="1" v-model.number="currentRiskSettings.maxCopyPercentOfBalance" @change="updateRiskSettings" class="flex-1 accent-purple-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                  <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-purple-900/50 rounded-xl px-3 py-2">
                    <input type="number" min="1" max="100" v-model.number="currentRiskSettings.maxCopyPercentOfBalance" @change="updateRiskSettings" class="w-full bg-transparent text-white font-mono text-base text-right outline-none" />
                    <span class="text-purple-500 font-bold text-sm">%</span>
                  </div>
                </div>
              </div>
            </template>

            <div class="border-t border-zinc-800/80 my-2"></div>

            <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
              <div class="flex justify-between items-center mb-2">
                <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Take Profit</label>
                <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border" :class="(currentRiskSettings.takeProfitThreshold || 0) >= 40 ? 'text-[#D4AF37] bg-[#D4AF37]/10 border-[#D4AF37]/40' : (currentRiskSettings.takeProfitThreshold || 0) <= 15 ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' : 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40'">
                  {{ (currentRiskSettings.takeProfitThreshold || 0) >= 40 ? 'PACIENTE' : ((currentRiskSettings.takeProfitThreshold || 0) <= 15 ? 'AGRESIVO' : 'ESTÁNDAR') }}
                </span>
              </div>
              <div class="flex items-center gap-4">
                <input type="range" min="5" max="100" step="1" v-model.number="currentRiskSettings.takeProfitThreshold" @change="updateRiskSettings" class="flex-1 accent-emerald-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-emerald-900/30 rounded-xl px-3 py-2">
                  <input type="number" min="5" max="100" step="1" v-model.number="currentRiskSettings.takeProfitThreshold" @change="updateRiskSettings" class="w-full bg-transparent text-emerald-400 font-mono text-base text-right outline-none" />
                  <span class="text-emerald-600 font-bold text-sm">%</span>
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
              <div class="flex justify-between items-center mb-2">
                <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Stop Loss</label>
                <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border" :class="(currentRiskSettings.stopLossThreshold || 0) <= -50 ? 'text-[#D4AF37] bg-[#D4AF37]/10 border-[#D4AF37]/40' : (currentRiskSettings.stopLossThreshold || 0) >= -15 ? 'text-rose-400 bg-rose-400/10 border-rose-400/40' : 'text-rose-500 bg-rose-500/10 border-rose-500/40'">
                  {{ (currentRiskSettings.stopLossThreshold || 0) <= -50 ? 'PACIENTE' : ((currentRiskSettings.stopLossThreshold || 0) >= -15 ? 'ESTRICTO' : 'ESTÁNDAR') }}
                </span>
              </div>
              <div class="flex items-center gap-4">
                <input type="range" min="-100" max="-5" step="1" v-model.number="currentRiskSettings.stopLossThreshold" @change="updateRiskSettings" class="flex-1 accent-rose-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-rose-900/30 rounded-xl px-3 py-2">
                  <input type="number" max="-5" step="1" v-model.number="currentRiskSettings.stopLossThreshold" @change="updateRiskSettings" class="w-full bg-transparent text-rose-400 font-mono text-base text-right outline-none" />
                  <span class="text-rose-600 font-bold text-sm">%</span>
                </div>
              </div>
            </div>

            <div class="border-t border-zinc-800/80 my-2"></div>

            <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
              <div class="flex justify-between items-center mb-2">
                <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Slippage Entrada (Compras)</label>
                <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-[#D4AF37] bg-[#D4AF37]/10 border-[#D4AF37]/40">NORMAL</span>
              </div>
              <div class="flex items-center gap-4">
                <input type="range" min="1" max="15" step="1" v-model.number="status.riskSettings.entrySlippage" @change="updateQuantumRiskSettings" class="flex-1 accent-[#D4AF37] h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-zinc-700 rounded-xl px-3 py-2">
                  <input type="number" min="1" max="15" v-model.number="status.riskSettings.entrySlippage" @change="updateQuantumRiskSettings" class="w-full bg-transparent text-[#D4AF37] font-mono text-base text-right outline-none" />
                  <span class="text-zinc-500 font-bold text-sm">%</span>
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-rose-500/20 bg-[#161619] relative overflow-hidden">
              <div class="flex justify-between items-center mb-2">
                <label class="text-[10px] sm:text-xs text-rose-400 font-black uppercase tracking-[0.2em]">Slippage Pánico (S.L.)</label>
                <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-rose-400 bg-rose-500/10 border-rose-500/40">EMERGENCIA</span>
              </div>
              <div class="flex items-center gap-4">
                <input type="range" min="10" max="60" step="1" v-model.number="status.riskSettings.panicSlippage" @change="updateQuantumRiskSettings" class="flex-1 accent-rose-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-rose-900/50 rounded-xl px-3 py-2">
                  <input type="number" min="10" max="60" v-model.number="status.riskSettings.panicSlippage" @change="updateQuantumRiskSettings" class="w-full bg-transparent text-rose-400 font-mono text-base text-right outline-none" />
                  <span class="text-rose-600 font-bold text-sm">%</span>
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-zinc-800/60 bg-[#161619] relative overflow-hidden">
              <div class="flex justify-between items-center mb-2">
                <label class="text-[10px] sm:text-xs text-zinc-400 font-black uppercase tracking-[0.2em]">Cooldown (Filtro Spam)</label>
                <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-zinc-300 bg-zinc-700/30 border-zinc-600/50">TIEMPO</span>
              </div>
              <div class="flex items-center gap-4">
                <input type="range" min="0" max="120" step="5" v-model.number="status.riskSettings.tradeCooldownMin" @change="updateQuantumRiskSettings" class="flex-1 accent-zinc-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer" />
                <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-zinc-700 rounded-xl px-3 py-2">
                  <input type="number" min="0" max="120" v-model.number="status.riskSettings.tradeCooldownMin" @change="updateQuantumRiskSettings" class="w-full bg-transparent text-white font-mono text-base text-right outline-none" />
                  <span class="text-zinc-500 font-bold text-sm">Min</span>
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-2 p-4 md:p-5 rounded-xl border border-rose-500/30 bg-[#161619] relative overflow-hidden shadow-[0_0_20px_rgba(244,63,94,0.05)] mt-4">
              <div class="absolute -right-4 -top-4 opacity-10 pointer-events-none">
                <Power :size="80" class="text-rose-500" />
              </div>
              <div class="flex justify-between items-center mb-2 relative z-10">
                <label class="text-[10px] sm:text-xs text-rose-400 font-black uppercase tracking-[0.2em]">Pérdida Max. Diaria</label>
                <span class="text-[8px] sm:text-[10px] font-black px-2 py-1 rounded border text-rose-400 bg-rose-500/10 border-rose-500/40">GLOBAL (BOT KILLER)</span>
              </div>
              <div class="flex items-center gap-4 relative z-10">
                <input type="range" min="5" max="50" step="1" v-model.number="status.dailyLossLimit" @change="updateConfig" class="flex-1 accent-rose-500 h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer shadow-inner" />
                <div class="flex items-center gap-1 w-28 shrink-0 bg-[#09090b] border border-rose-900/50 rounded-xl px-3 py-2">
                  <input type="number" min="5" max="50" v-model.number="status.dailyLossLimit" @change="updateConfig" class="w-full bg-transparent text-rose-400 font-mono text-base text-right outline-none" />
                  <span class="text-rose-600 font-bold text-sm">%</span>
                </div>
              </div>
              <p class="text-[9px] text-zinc-500 font-medium relative z-10 mt-1 uppercase tracking-widest">
                Si la cartera baja más de este %, el bot activa el Freno de Emergencia.
              </p>
            </div>

          </div>
        </div>

        <!-- ====================== FILTRO DE MERCADOS SECTION ====================== -->
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
                {{ status.maxActiveSportsMarkets === 0 ? 'ILIMITADO' : status.maxActiveSportsMarkets + ' MERCADOS' }}
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
      
        <!-- ====================== AUTOPILOT SNIPER SECTION ====================== -->
        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-[0_0_50px_rgba(16,185,129,0.02)] hover:border-emerald-500/30 mb-8">
          <div class="absolute -top-32 -right-32 w-64 h-64 bg-emerald-500 rounded-full blur-[100px] opacity-10 pointer-events-none transition-colors duration-700"></div>
          <div class="absolute -right-6 -top-6 opacity-5 group-hover:opacity-10 transition-all duration-700 pointer-events-none">
            <Cpu :size="150" class="text-emerald-500" />
          </div>
          
          <div class="flex items-center justify-between relative z-10">
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
        </div>

        <!-- ====================== COPY TRADING AUTO ====================== -->
        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-[0_0_50px_rgba(16,185,129,0.02)] hover:border-emerald-500/30">
          <div class="absolute -top-32 -right-32 w-64 h-64 bg-emerald-500 rounded-full blur-[100px] opacity-10 pointer-events-none transition-colors duration-700"></div>
          
          <div class="flex items-center justify-between mb-8 relative z-10 pb-6 border-b border-zinc-800/80">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border transition-colors duration-500 shadow-inner shrink-0 bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                <Target :size="24" />
              </div>
              <div>
                <h3 class="text-white font-black text-lg tracking-tight">Copy Trading Auto</h3>
                <p class="text-xs text-zinc-500 font-medium">Sigue las mejores ballenas del leaderboard</p>
              </div>
            </div>
            
            <!-- Toggle Auto -->
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input 
                type="checkbox" 
                v-model="status.copyTradingAutoEnabled" 
                @change="updateCopyTrading" 
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-[#09090b] border border-zinc-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-emerald-500/20 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-400 after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 peer-checked:border-emerald-500 group-hover/toggle:shadow-[0_0_15px_rgba(16,185,129,0.3)]"></div>
            </label>
          </div>

          <div v-if="status.copyTradingAutoEnabled" class="relative z-10 space-y-6">
            
            <!-- Slider de cantidad de ballenas -->
            <div class="flex flex-col p-5 rounded-2xl bg-[#161619] border border-zinc-800/60 hover:border-zinc-700/80 transition-colors w-full sm:w-1/2 md:w-1/3">
              <div class="flex justify-between items-start mb-4 gap-2">
                <label class="text-[10px] text-zinc-400 font-bold uppercase tracking-widest leading-snug">Top Whales</label>
                <span class="text-[9px] font-black px-2 py-1 rounded-md border text-emerald-400 bg-emerald-400/10 border-emerald-400/20 shrink-0">SEG.</span>
              </div>
              <div class="relative w-full mt-auto">
                <input 
                  type="number" 
                  min="1" 
                  max="20" 
                  step="1" 
                  v-model.number="status.maxWhalesToCopy" 
                  @change="updateCopyTrading" 
                  class="w-full h-12 bg-[#09090b] border border-zinc-800/80 rounded-xl pl-4 pr-16 text-white font-mono text-lg font-bold outline-none transition-all placeholder-zinc-700 appearance-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50" 
                />
                <span class="absolute right-4 top-1/2 -translate-y-1/2 text-emerald-600/50 font-black pointer-events-none text-xs">USERS</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="20" 
                step="1" 
                v-model.number="status.maxWhalesToCopy" 
                @change="updateCopyTrading" 
                class="w-full h-1 mt-4 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-emerald-500" 
              />
            </div>
              
            <!-- Lista de ballenas seleccionadas automáticamente -->
            <div class="pt-2">
              <p class="text-[11px] text-zinc-500 font-bold uppercase tracking-widest mb-3 px-1">Whales seleccionadas automáticamente</p>
              <div class="max-h-52 overflow-y-auto custom-scroll space-y-2 pr-2">
                <div v-for="(whale, i) in status.autoSelectedWhales || []" :key="i" 
                     class="bg-[#09090b] border border-zinc-800/80 rounded-xl p-3.5 flex justify-between items-center hover:border-emerald-500/30 transition-colors group">
                  <div class="font-mono text-emerald-400/80 text-xs font-medium group-hover:text-emerald-400">
                    {{ whale.address.substring(0,12) }}...
                  </div>
                  <div class="flex gap-4 text-[10px] font-black tracking-wide">
                    <span class="text-emerald-500/80 bg-emerald-500/10 px-2 py-1 rounded-md border border-emerald-500/20">
                      +${{ Number(whale.pnl || 0).toLocaleString(undefined, {maximumFractionDigits: 0}) }}
                    </span>
                    <span class="text-zinc-500 bg-zinc-800/50 px-2 py-1 rounded-md border border-zinc-700/50 hidden sm:block">
                      VOL: ${{ Number(whale.volume || 0).toLocaleString(undefined, {maximumFractionDigits: 0}) }}
                    </span>
                  </div>
                </div>
                <div v-if="!status.autoSelectedWhales || status.autoSelectedWhales.length === 0" 
                     class="text-center py-6 border border-dashed border-zinc-800 rounded-xl text-zinc-500 text-xs font-medium">
                  Esperando selección automática...
                </div>
              </div>
            </div>
          </div>

          <div v-else class="text-center py-10 bg-[#09090b] rounded-2xl border border-zinc-800/50 relative z-10 mt-6">
            <Target :size="32" class="text-zinc-700 mx-auto mb-3" />
            <p class="text-zinc-500 text-sm font-medium">Activa Copy Trading Auto para seguir las mejores ballenas</p>
          </div>
        </div>

        <!-- ====================== COPY TRADING CUSTOM ====================== -->
        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all duration-500 relative overflow-hidden group shadow-[0_0_50px_rgba(168,85,247,0.02)] hover:border-purple-500/30">
          <div class="absolute -top-32 -right-32 w-64 h-64 bg-purple-500 rounded-full blur-[100px] opacity-10 pointer-events-none transition-colors duration-700"></div>
          
          <div class="flex items-center justify-between mb-8 relative z-10 pb-6 border-b border-zinc-800/80">
            <div class="flex items-center gap-4">
              <div class="p-3.5 rounded-2xl border transition-colors duration-500 shadow-inner shrink-0 bg-purple-500/10 border-purple-500/20 text-purple-400">
                <Target :size="24" />
              </div>
              <div>
                <div class="flex items-center gap-3">
                  <h3 class="text-white font-black text-lg tracking-tight">Copy Trading Custom</h3>
                  <span class="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border"
                        :class="(status.customWhales?.length || 0) >= 20 ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' : 'bg-purple-500/10 text-purple-400 border-purple-500/30'">
                    {{ status.customWhales?.length || 0 }} / 20 MAX
                  </span>
                </div>
                <p class="text-xs text-zinc-500 font-medium">Agrega y controla tus propias ballenas</p>
              </div>
            </div>
            
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input 
                type="checkbox" 
                v-model="status.copyTradingCustomEnabled" 
                @change="updateCopyTrading" 
                class="sr-only peer" 
              />
              <div class="w-11 h-6 bg-[#09090b] border border-zinc-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-purple-500/20 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-400 after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500 peer-checked:border-purple-500 group-hover/toggle:shadow-[0_0_15px_rgba(168,85,247,0.3)]"></div>
            </label>
          </div>

          <div v-if="status.copyTradingCustomEnabled" class="relative z-10 space-y-8">

            <!-- ==================== NUEVOS FILTROS CONFIGURABLES ==================== -->
            <div class="bg-[#161619] border border-purple-500/20 p-6 rounded-2xl space-y-6">
              <h4 class="text-[11px] font-black uppercase tracking-widest text-purple-400 mb-4">Filtros de Copy Trading</h4>
              
              <!-- Tamaño mínimo de trade -->
              <div>
                <div class="flex justify-between items-center mb-2">
                  <label class="text-xs text-zinc-400 font-medium">Tamaño mínimo de trade de ballena</label>
                  <span class="font-mono text-purple-400">${{ status.copyMinWhaleSize }}</span>
                </div>
                <div class="flex items-center gap-4">
                  <input 
                    type="range" 
                    min="50" 
                    max="500" 
                    step="25" 
                    v-model.number="status.copyMinWhaleSize" 
                    @change="updateCopyFilters" 
                    class="flex-1 accent-purple-500" 
                  />
                  <input 
                    type="number" 
                    v-model.number="status.copyMinWhaleSize" 
                    @change="updateCopyFilters" 
                    class="w-20 bg-[#09090b] border border-purple-500/30 text-purple-400 font-mono text-center rounded-xl px-3 py-1" 
                  />
                </div>
              </div>

              <!-- Ventana de tiempo -->
              <div>
                <div class="flex justify-between items-center mb-2">
                  <label class="text-xs text-zinc-400 font-medium">Ventana de tiempo (minutos)</label>
                  <span class="font-mono text-purple-400">{{ status.copyTimeWindowMinutes }} min</span>
                </div>
                <div class="flex items-center gap-4">
                  <input 
                    type="range" 
                    min="15" 
                    max="90" 
                    step="5" 
                    v-model.number="status.copyTimeWindowMinutes" 
                    @change="updateCopyFilters" 
                    class="flex-1 accent-purple-500" 
                  />
                  <input 
                    type="number" 
                    v-model.number="status.copyTimeWindowMinutes" 
                    @change="updateCopyFilters" 
                    class="w-20 bg-[#09090b] border border-purple-500/30 text-purple-400 font-mono text-center rounded-xl px-3 py-1" 
                  />
                </div>
                <p class="text-[10px] text-zinc-500 mt-1">Tiempo máximo desde que la ballena hizo el trade</p>
              </div>
            </div>

            <!-- ==================== SLIDER LÍMITE POR BALLENA ==================== -->
            <div class="bg-[#161619] border border-purple-500/20 p-6 rounded-2xl">
              <div class="flex items-center justify-between mb-4">
                <h4 class="text-[11px] font-black uppercase tracking-widest text-purple-400">Límite de mercados por ballena</h4>
                <span class="text-[10px] font-mono font-bold px-3 py-1 rounded-md transition-colors"
                      :class="status.maxCopyMarketsPerWhale === 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-purple-500/10 text-purple-400 border border-purple-500/30'">
                  {{ status.maxCopyMarketsPerWhale === 0 ? 'ILIMITADO' : status.maxCopyMarketsPerWhale + ' MERCADOS' }}
                </span>
              </div>

              <div class="flex items-center gap-4">
                <input 
                  type="range" 
                  min="0" 
                  max="20" 
                  v-model.number="status.maxCopyMarketsPerWhale"
                  @change="updateCopyLimitPerWhale" 
                  class="flex-1 accent-purple-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                />
                <button 
                  @click="status.maxCopyMarketsPerWhale = 0; updateCopyLimitPerWhale()"
                  class="text-[10px] font-black tracking-widest px-5 py-2.5 rounded-xl transition-all duration-300"
                  :class="status.maxCopyMarketsPerWhale === 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.1)]' : 'bg-[#161619] text-zinc-500 border border-zinc-800/60 hover:border-purple-500 hover:text-purple-400'"
                >
                  AUTO (Ilimitado)
                </button>
              </div>
              
              <p class="text-[10px] text-zinc-500 mt-4 font-medium">
                <span class="text-purple-400">•</span> 
                Valor actual: <strong class="font-mono">{{ status.maxCopyMarketsPerWhale === 0 ? 'Sin límite' : status.maxCopyMarketsPerWhale + ' mercado(s) por ballena' }}</strong><br>
                <span class="text-[9px]">Ejemplo: Si pones 1, cada ballena solo puede tener 1 posición activa al mismo tiempo.</span>
              </p>
            </div>

            <!-- Agregar ballena -->
            <div class="flex flex-col sm:flex-row gap-3">
              <input 
                v-model="newWhaleAddress"
                :disabled="(status.customWhales?.length || 0) >= 20"
                :placeholder="(status.customWhales?.length || 0) >= 20 ? 'Límite de 10 ballenas alcanzado' : '0x1234...abcd'"
                class="w-full sm:flex-1 bg-[#09090b] border border-zinc-700 rounded-2xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <div class="flex gap-3 w-full sm:w-auto">
                <input 
                  v-model="newWhaleNickname"
                  :disabled="(status.customWhales?.length || 0) >= 20"
                  placeholder="Nickname (opcional)"
                  class="flex-1 sm:w-36 bg-[#09090b] border border-zinc-700 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button 
                  @click="addCustomWhale"
                  :disabled="(status.customWhales?.length || 0) >= 20"
                  class="px-6 py-3 rounded-2xl font-bold text-sm transition-all whitespace-nowrap shrink-0 shadow-lg disabled:cursor-not-allowed"
                  :class="(status.customWhales?.length || 0) >= 20 ? 'bg-zinc-800 text-zinc-500 shadow-none' : 'bg-purple-600 hover:bg-purple-500 text-white'">
                  Agregar
                </button>
              </div>
            </div>

            <!-- Lista de ballenas -->
            <div v-if="status.customWhales && status.customWhales.length > 0" class="max-h-52 overflow-y-auto custom-scroll space-y-2 pr-2">
              <div v-for="(whale, index) in status.customWhales" :key="index"
                  class="bg-[#09090b] border border-zinc-800/80 rounded-xl p-3.5 flex justify-between items-center hover:border-purple-500/30 transition-colors group">
                <div class="flex items-center gap-3 truncate pr-2">
                  <input 
                    type="checkbox" 
                    v-model="whale.enabled"
                    @change="toggleCustomWhale(whale.address)"
                    class="w-4 h-4 accent-purple-500 shrink-0"
                  />
                  <div class="truncate">
                    <div class="font-mono text-purple-400/80 text-xs font-medium group-hover:text-purple-400 truncate">
                      {{ whale.address.substring(0,8) }}...{{ whale.address.slice(-6) }}
                    </div>
                    <div v-if="whale.nickname" class="text-[10px] text-zinc-500 truncate">{{ whale.nickname }}</div>
                  </div>
                </div>
                <button 
                  @click="deleteCustomWhale(whale.address)"
                  class="text-rose-400 hover:text-rose-500 text-xs font-medium px-3 py-1 shrink-0 bg-rose-500/10 rounded-lg">
                  Eliminar
                </button>
              </div>
            </div>
            
            <div v-else class="text-center py-8 text-zinc-500 text-sm border border-dashed border-zinc-700 rounded-2xl bg-[#09090b]/50">
              No hay ballenas personalizadas aún
            </div>
          </div>

          <div v-else class="text-center py-10 bg-[#09090b] rounded-2xl border border-zinc-800/50 relative z-10 mt-6">
            <Target :size="32" class="text-zinc-700 mx-auto mb-3" />
            <p class="text-zinc-500 text-sm font-medium">Activa Copy Trading Custom para agregar tus propias ballenas</p>
          </div>
        </div>

        <!-- ====================== DATOS DEL SISTEMA ====================== -->
        <div class="bg-[#111114] border border-zinc-800/80 rounded-[2rem] p-6 lg:p-8 transition-all shadow-lg hover:border-zinc-700/50">
          <h3 class="text-zinc-400 font-black text-xs uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
            <Activity :size="16" class="text-zinc-500" />
            Datos del Sistema
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