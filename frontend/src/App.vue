<script setup>
import { ref, onMounted, computed } from 'vue'
import axios from 'axios'
import { 
  Activity, Wallet, TrendingUp, Newspaper, Zap, 
  AlertTriangle, CheckCircle2, XCircle, Power, Clock3,
  Search, ExternalLink, Bot, RefreshCcw, Loader2, ShieldCheck,
  ArrowUpRight, Languages, Target, ArrowDown, Check, Cpu
} from 'lucide-vue-next'
import Swal from 'sweetalert2';

const API_URL = 'http://localhost:3001/api';

const status = ref({
  lastCheck: null,
  lastProbability: 0,
  currentMarket: 'Cargando market...',
  lastNews: [],
  balanceUSDC: '0.00',
  balancePOL: '0.00',
  executions: [],
  isPanicStopped: false, // Nuevo estado para el Stop Loss
  autoTradeEnabled: false,
  microBetAmount: 1.00
})

const isAutoTradeUpdating = ref(false);

const updateAutoTrade = async () => {
  isAutoTradeUpdating.value = true;
  try {
    await axios.post('http://localhost:3001/api/settings/autotrade', {
      enabled: status.value.autoTradeEnabled,
      amount: status.value.microBetAmount
    });
    console.log("✅ AutoTrade settings updated");
  } catch (error) {
    console.error("❌ Error updating AutoTrade:", error);
  } finally {
    isAutoTradeUpdating.value = false;
  }
};

const markets = ref([])
const isLoading = ref(true)
const isSwapping = ref(false);
const isThresholdUpdating = ref(false);
const portfolio = ref([]);

const fetchStatus = async () => {
  try {
    const res = await axios.get(`${API_URL}/status`)
    status.value = res.data
  } catch (e) { console.error("Error API Status", e) }
}

const fetchMarkets = async () => {
  try {
    const res = await axios.get(`${API_URL}/markets`)
    markets.value = res.data
    isLoading.value = false
  } catch (e) { console.error("Error API Markets", e) }
}

const getTopicName = (topic) => {
  if (!topic) return "Cargando radar...";
  if (topic.includes("NOAA")) return "Meteorología e Impactos Climáticos (NOAA)";
  if (topic.includes("bitcoin")) return "Micro-movimientos BTC Corto Plazo";
  if (topic.includes("macro")) return "Eventos Macroeconómicos Globales";
  return "Mercados de Predicción General";
};

const fetchPortfolio = async () => {
  try {
    const response = await axios.get('http://localhost:3001/api/portfolio');
    portfolio.value = response.data;
  } catch (error) {
    console.error("Error cargando portafolio:", error);
  }
};

const changeMarket = async (newMarket) => {
  try {
    await axios.post(`${API_URL}/change-market`, { newMarket })
    // Notificación visual temporal
    alert(`⚡️ Cambiando objetivo a: ${newMarket}`)
    fetchStatus()
  } catch (e) { alert("Error al cambiar") }
}

// Lógica de Pánico / Stop Loss
const triggerPanicStop = async () => {
  if (confirm("⚠️ ¿ESTÁS SEGURO? Esto detendrá todas las operaciones del bot inmediatamente.")) {
    try {
      await axios.post(`${API_URL}/panic-stop`)
      status.value.isPanicStopped = true;
      alert("🛑 BOT DETENIDO DE EMERGENCIA.");
    } catch (e) { alert("Error al detener") }
  }
}

const probColor = computed(() => {
  if (status.value.isPanicStopped) return 'text-zinc-700';
  
  // SEÑAL SNIPER (Dorado Brillante con Sombra)
  if (status.value.lastProbability > 0.80) {
    return 'text-[#D4AF37] drop-shadow-[0_0_12px_rgba(212,175,55,0.6)] font-black';
  }
  
  // SEÑAL ALERTA (Ámbar suave)
  if (status.value.lastProbability > 0.60) {
    return 'text-amber-500/80 font-bold';
  }
  
  // NEUTRAL
  return 'text-zinc-600 font-medium';
});

const activateSniper = async (marketName, mockProbability) => {
  // 1. Actualizamos la UI inmediatamente para dar feedback visual
  status.value.currentMarket = marketName;
  status.value.lastProbability = mockProbability; // Forzamos la señal dorada en el dashboard
  
  try {
    // 2. Enviamos la orden al Backend para que cambie el mercado real
    await axios.post('http://localhost:3001/api/change-market', { 
      market: marketName 
    });
    
    // 3. Pequeña notificación visual (opcional)
    console.log(`🎯 Modo Sniper Activado: ${marketName} con probabilidad objetivo de ${mockProbability*100}%`);
    
  } catch (error) {
    console.error("Error al activar modo sniper:", error);
  }
};

const approveSignal = async (signal) => {
  // Evitamos clics dobles si ya está procesando
  if (signal.loading) return;

  // 1. Activamos el estado de carga localmente en la señal
  signal.loading = true;

  try {
    // 2. Enviamos al backend
    const response = await axios.post('http://localhost:3001/api/execute-trade', {
      market: signal.marketName,
      amount: signal.suggestedInversion || 5, 
      conditionId: signal.conditionId,
      tokenId: signal.tokenId,
      probability: signal.probability
    });

    if (response.data.success) {
      // 3. Quitamos la card con una transición suave
      status.value.pendingSignals = status.value.pendingSignals.filter(s => s.id !== signal.id);
      
      // 4. Refrescamos balances (opcional, para ver el descuento de los 5 USDC)
      await fetchStatus(); 
      
      console.log("🚀 Orden enviada a Polymarket con éxito");
    }
  } catch (error) {
    console.error("Error al ejecutar trade:", error);
    // Podrías lanzar un SweetAlert aquí si el backend falla
  } finally {
    // 5. Siempre liberamos el estado, pase lo que pase
    signal.loading = false;
  }
};

const rejectSignal = (id) => {
  status.value.pendingSignals = status.value.pendingSignals.filter(s => s.id !== id);
};

const insufficientFunds = ref(false); // Nueva variable de estado
const swapSuccess = ref(false); // Nueva variable

const executeSwap = async () => {
  const montoASwap = parseFloat(swapAmount.value);
  if (!montoASwap || montoASwap <= 0) return;
  
  const saldoDisponible = parseFloat(status.balancePOL);

  // VALIDACIÓN CON FEEDBACK EN BOTÓN
  if (montoASwap > saldoDisponible) {
    insufficientFunds.value = true;
    
    // Regresamos el botón a la normalidad después de 3 segundos
    setTimeout(() => {
      insufficientFunds.value = false;
    }, 3000);
    
    return; // Detenemos la ejecución aquí
  }

  // Si hay saldo, procedemos normalmente
  isSwapping.value = true;
  try {
    const response = await axios.post('http://localhost:3001/api/swap-custom', {
      amount: swapAmount.value
    });

    if (response.data.success) {
      swapSuccess.value = true;
      swapAmount.value = null;

      // 🔄 ESTA ES LA CLAVE: Llamar a tu función que trae los balances
      await fetchStatus(); 

      setTimeout(() => { swapSuccess.value = false; }, 4000);
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    isSwapping.value = false;
  }
};

// Asegúrate de tener estas variables reactivas
const swapAmount = ref(0); // Iniciamos en 0 para evitar el NaN
const polPrice = ref(0.45); // Precio actual aprox del POL (puedes ajustarlo)

// Una función de ayuda para limpiar el cálculo
const estimatedUsdc = computed(() => {
  const amt = parseFloat(swapAmount.value);
  if (isNaN(amt) || amt <= 0) return 0;
  return (amt * polPrice.value).toFixed(2);
});

const setThreshold = async (val) => {
  status.value.predictionThreshold = val;
  await updateThreshold();
};

const updateThreshold = async () => {
  console.log("Iniciando recalibración de umbral...");
  isThresholdUpdating.value = true;
  
  try {
    await axios.post('http://localhost:3001/api/settings/threshold', {
      threshold: parseFloat(status.value.predictionThreshold)
    });
    
    // Opcional: Pequeña pausa artificial de 500ms para que el usuario note el cambio de estado
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log("✅ Umbral sincronizado con el motor de IA");
  } catch (error) {
    console.error("❌ Error en la sincronización:", error);
  } finally {
    isThresholdUpdating.value = false;
  }
};

const isTestingUkraine = ref(false);

async function executeUkraineTest() {
  if (!confirm("¿Ejecutar compra real de 3.00 USDC en el mercado de Ucrania?")) return;
  
  isTestingUkraine.value = true;
  try {
    // 💡 CAMBIO AQUÍ: Usamos API_URL en lugar de API_BASE
    const response = await axios.post(`${API_URL}/trade-ukraine`, {
      amount: 3.00
    });
    
    if (response.data.success) {
      alert("¡Snipe Exitoso! Revisa la terminal y los logs.");
    }
  } catch (error) {
    console.error("Error en test:", error);
    alert("Error: " + (error.response?.data?.error || error.message));
  } finally {
    isTestingUkraine.value = false;
  }
}

const isDeepTesting = ref(false);

async function runDeepTestClob() {
  const confirmAction = await Swal.fire({
    title: '¿Ejecutar Test Completo?',
    text: "Esto validará permisos en la blockchain y enviará la orden de 3 USDC.",
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#0891b2',
    confirmButtonText: 'Sí, ejecutar',
    background: '#1c1917',
    color: '#fff'
  });

  if (!confirmAction.isConfirmed) return;

  isDeepTesting.value = true;
  try {
    const res = await axios.post(`${API_URL}/execute-test-clob`);
    if (res.data.success) {
      Swal.fire('¡Éxito!', `Orden aceptada: ${res.data.orderID}`, 'success');
      fetchStatus(); // Refrescar balances
    }
  } catch (error) {
    Swal.fire('Error', error.response?.data?.error || error.message, 'error');
  } finally {
    isDeepTesting.value = false;
  }
}

const isTesting = ref(false);

const runSniperTest = async () => {
  isTesting.value = true;
  try {
    const res = await axios.post(`${API_URL}/execute-test-sniper`);
    if (res.data.success) {
      alert(`✅ ¡Orden aceptada! ID: ${res.data.orderID}`);
      fetchStatus(); // Refresca balances
    }
  } catch (e) {
    alert(`❌ Error: ${e.response?.data?.error || e.message}`);
  } finally {
    isTesting.value = false;
  }
};

onMounted(() => {
  fetchStatus()
  fetchMarkets()
  fetchPortfolio();
  setInterval(fetchStatus, 5000) // Actualiza cada 5 seg
})
</script>

<template>
  <div class="min-h-screen bg-[#09090b] text-zinc-300 font-sans p-4 md:p-8 selection:bg-emerald-500/20 selection:text-emerald-300">
    
    <div v-if="status.isPanicStopped" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-10 text-center border-4 border-red-500/50 rounded-2xl m-6">
      <AlertTriangle :size="100" class="text-red-500 animate-pulse mb-6" />
      <h1 class="text-6xl font-black text-white tracking-tighter mb-4">SYSTEM HALTED</h1>
      <p class="text-xl text-red-300 max-w-2xl mb-8">El Bot ha sido detenido manualmente por emergencia. No se ejecutarán más órdenes hasta que reinicies el backend.</p>
      <button onclick="window.location.reload()" class="bg-white text-black font-bold px-8 py-3 rounded-full hover:bg-zinc-200 transition">Reiniciar Interfaz</button>
    </div>

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
        <button @click="triggerPanicStop" class="flex items-center gap-2.5 bg-red-950 text-red-300 px-5 py-3 rounded-full text-sm font-bold hover:bg-red-900 transition active:scale-95 group">
          <Power :size="18" class="text-red-500 group-hover:animate-pulse" />
          EMERGENCY STOP
        </button>
      </div>
    </header>

    <main class="max-w-[1600px] mx-auto grid grid-cols-12 gap-8">
      
      <div class="col-span-12 xl:col-span-8 space-y-8">
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          <div 
            class="relative overflow-hidden p-6 rounded-3xl shadow-xl flex items-start gap-4 transition-all duration-500 group border-2"
            :class="status.lastProbability > 0.75 
              ? 'bg-[#1c1917] border-[#D4AF37] shadow-[0_0_30px_rgba(212,175,55,0.3)] scale-[1.02]' 
              : 'bg-[#111114] border-zinc-800 hover:border-[#D4AF37]/40'"
          >
            <div v-if="status.lastProbability > 0.75" class="absolute inset-0 bg-gradient-to-br from-[#D4AF37]/10 to-transparent"></div>

            <div 
              class="p-3 rounded-xl border shadow-inner group-hover:scale-110 transition-transform relative z-10"
              :class="status.lastProbability > 0.75 ? 'bg-[#D4AF37] border-[#D4AF37]' : 'bg-blue-950/50 border-blue-900'"
            >
              <Wallet :size="24" :class="status.lastProbability > 0.75 ? 'text-[#3C2A21]' : 'text-blue-400'" />
            </div>

            <div class="relative z-10"> 
              <p class="text-[10px] uppercase font-black tracking-[0.15em] mb-2 transition-colors" 
                :class="status.lastProbability > 0.75 ? 'text-[#D4AF37]' : 'text-zinc-500'">
                {{ status.lastProbability > 0.75 ? 'Capital en Operación' : 'Capital Disponible' }}
              </p>

              <div class="flex items-baseline gap-2"> 
                <h3 class="text-3xl font-extrabold text-white tracking-tighter font-mono leading-none">
                  {{ parseFloat(status.balanceUSDC || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
                </h3>
                <span class="text-[11px] font-bold tracking-widest opacity-80" 
                      :class="status.lastProbability > 0.75 ? 'text-[#D4AF37]' : 'text-zinc-600'">
                  USDC
                </span>
              </div>

              <div class="mt-4 flex items-center gap-2">
                <div class="w-1 h-1 rounded-full" :class="status.lastProbability > 0.75 ? 'bg-[#D4AF37] animate-pulse' : 'bg-zinc-700'"></div>
                <p class="text-[8px] font-bold text-zinc-600 uppercase tracking-widest">
                  Sistema: <span class="text-zinc-400">Bot Trading Real</span>
                </p>
              </div>
            </div>

            <div v-if="status.lastProbability > 0.75" class="absolute top-5 right-5">
              <div class="w-2 h-2 bg-[#D4AF37] rounded-full animate-ping"></div>
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-6 rounded-3xl shadow-xl flex items-start gap-4 hover:border-emerald-900/50 transition-all group">
            <div class="p-3 bg-emerald-950/30 rounded-xl border border-emerald-900/50 shadow-inner group-hover:scale-110 transition-transform">
              <Zap :size="24" class="text-emerald-500" />
            </div>
            <div>
              <p class="text-[10px] uppercase text-zinc-500 font-black tracking-[0.15em] mb-2">Network Gas (POL)</p>
              <div class="flex items-baseline gap-2">
                <h3 class="text-3xl font-extrabold text-zinc-200 tracking-tighter font-mono leading-none">
                  {{ parseFloat(status.balancePOL || 0).toFixed(3) }}
                </h3>
                <span class="text-[11px] font-bold text-zinc-600 tracking-widest uppercase">POL</span>
              </div>
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-6 rounded-3xl shadow-xl flex items-start gap-4 hover:border-amber-900/50 transition-all group relative overflow-hidden">
            <div class="p-3 bg-amber-950/30 rounded-xl border border-amber-900/50 shadow-inner group-hover:scale-110 transition-transform">
              <Activity :size="24" class="text-amber-500" />
            </div>
            <div class="relative z-10">
              <p class="text-[10px] uppercase text-zinc-500 font-black tracking-[0.15em] mb-2">Claude AI Signal</p>
              <h3 class="text-3xl font-extrabold tracking-tighter font-mono leading-none" :class="probColor">
                {{ (status.lastProbability * 100).toFixed(1) }}%
              </h3>
            </div>
            <div v-if="status.lastProbability > 0.75" class="absolute -right-4 -bottom-4 text-[#D4AF37]/10 rotate-12">
                <CheckCircle2 :size="80"/>
            </div>
          </div>

        </div>

        <div class="mt-8 bg-[#1C1612] border border-[#3C2A21] rounded-2xl overflow-hidden">
          <div class="p-6 border-b border-[#3C2A21] flex justify-between items-center bg-[#251B15]">
            <h3 class="text-[#D4AF37] font-black text-xs tracking-widest uppercase flex items-center gap-2">
              <div class="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse"></div>
              Inversiones en Curso (Blockchain)
            </h3>
            <span class="text-[10px] text-zinc-500 font-mono">LIVE TRACKING</span>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-[10px] text-zinc-500 uppercase tracking-tighter border-b border-[#3C2A21]">
                  <th class="p-4 font-medium">Mercado</th>
                  <th class="p-4 font-medium">Entrada</th>
                  <th class="p-4 font-medium">Actual</th>
                  <th class="p-4 font-medium">P/L (USDC)</th>
                </tr>
              </thead>
              <tbody class="text-xs">
                <tr v-for="pos in portfolio" :key="pos.id" class="border-b border-[#3C2A21]/50 hover:bg-[#2A1D15] transition-colors">
                  <td class="p-4">
                    <div class="font-bold text-zinc-200 line-clamp-1">{{ pos.market }}</div>
                    <a :href="'https://polygonscan.com/tx/' + pos.id" 
                      target="_blank" 
                      class="text-[9px] text-[#D4AF37] hover:underline font-mono uppercase tracking-tighter">
                      Ver Transacción ↗
                    </a>
                </td>
                  <td class="p-4 text-zinc-400 font-mono">${{ pos.price }}</td>
                  <td class="p-4 text-[#D4AF37] font-mono">${{ pos.currentPrice || '---' }}</td>
                  <td class="p-4 font-mono font-bold" :class="pos.profit >= 0 ? 'text-green-500' : 'text-red-500'">
                    {{ pos.profit >= 0 ? '+' : '' }}{{ pos.profit }}
                  </td>
                </tr>
                
                <tr v-if="portfolio.length === 0">
                  <td colspan="4" class="p-12 text-center text-zinc-600 italic">
                    No hay posiciones abiertas en la blockchain.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-zinc-800 rounded-3xl p-8 mb-8">
          <div class="flex items-center justify-between mb-8 pb-4 border-b border-zinc-800/50">
            <h2 class="text-xl font-bold text-white flex items-center gap-3">
                <ShieldCheck :size="24" class="text-[#D4AF37]" /> 
                Validación de Señales Claude 4.6
            </h2>
            <span class="text-[10px] font-black text-zinc-500 uppercase tracking-widest bg-zinc-900 px-3 py-1 rounded-full border border-zinc-800">
              Esperando tu aprobación para ejecutar
            </span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div v-for="signal in status.pendingSignals" :key="signal.id" 
                class="bg-[#1c1917] border border-[#D4AF37]/20 rounded-2xl p-5 hover:border-[#D4AF37]/60 transition-all group flex flex-col justify-between">
              
              <div>
                <div class="flex justify-between items-center mb-4">
                  <div class="flex items-center gap-2">
                    <!-- Category & Sniper Badges -->
                    <template v-if="signal.category === 'CRYPTO'">
                      <div class="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 rounded-full animate-pulse shadow-[0_0_10px_rgba(59,130,246,0.2)]">
                        <div class="w-1.5 h-1.5 bg-blue-400 rounded-full"></div>
                        <span class="text-[9px] font-black text-blue-300 uppercase tracking-widest">🪙 CRYPTO</span>
                      </div>
                    </template>
                    <template v-else-if="signal.category === 'GEOPOLITICS'">
                      <div class="flex items-center gap-1.5 bg-orange-500/10 border border-orange-500/30 px-2 py-0.5 rounded-full animate-pulse shadow-[0_0_10px_rgba(249,115,22,0.2)]">
                        <div class="w-1.5 h-1.5 bg-orange-500 rounded-full"></div>
                        <span class="text-[9px] font-black text-orange-400 uppercase tracking-widest">🌍 GEO</span>
                      </div>
                    </template>
                    <template v-else-if="signal.category === 'SOCIAL'">
                      <div class="flex items-center gap-1.5 bg-purple-500/10 border border-purple-500/30 px-2 py-0.5 rounded-full animate-pulse shadow-[0_0_10px_rgba(168,85,247,0.2)]">
                        <div class="w-1.5 h-1.5 bg-purple-400 rounded-full"></div>
                        <span class="text-[9px] font-black text-purple-300 uppercase tracking-widest">📱 SOCIAL</span>
                      </div>
                    </template>
                    
                    <template v-if="signal.edge !== null && signal.edge !== undefined && Number(signal.edge) >= 0.10 && signal.endsIn">
                      <div class="flex items-center gap-1.5 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full animate-pulse">
                        <div class="w-1.5 h-1.5 bg-red-500 rounded-full"></div>
                        <span class="text-[8px] font-black text-red-400 uppercase tracking-widest">🎯 SNIPER</span>
                      </div>
                    </template>
                    <template v-else-if="!signal.category">
                      <div class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                      <span class="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Live Intel</span>
                    </template>
                  </div>
                  <div class="flex flex-col items-end">
                    <span class="text-2xl font-black text-[#D4AF37] font-mono leading-none">
                      {{ (signal.probability * 100).toFixed(0) }}%
                    </span>
                    <span v-if="signal.endsIn" class="text-[9px] text-red-400 font-bold font-mono">⏰ {{ signal.endsIn }}</span>
                  </div>
                </div>

                <p class="text-white font-bold text-sm leading-tight mb-2 group-hover:text-[#D4AF37] transition-colors line-clamp-2" :title="signal.marketName">
                  {{ signal.marketName }}
                </p>

                <div class="flex items-center gap-2 my-3 opacity-30">
                  <div class="h-[1px] flex-1 bg-gradient-to-r from-transparent via-[#D4AF37]/50 to-transparent"></div>
                  <Languages :size="10" class="text-[#D4AF37]/50" />
                  <div class="h-[1px] flex-1 bg-gradient-to-r from-[#D4AF37]/50 via-transparent to-transparent"></div>
                </div>

                <!-- Solo mostramos el título traducido si es DIFERENTE al original -->
                <p v-if="signal.marketName_es && signal.marketName_es !== signal.marketName" 
                   class="text-zinc-400 text-xs italic leading-snug mb-4 font-medium border-l-2 border-[#D4AF37]/30 pl-3 line-clamp-2">
                  {{ signal.marketName_es }}
                </p>

                <div class="relative mb-5 group/analysis">
                  <div class="absolute -top-2 left-3 px-2 bg-[#1c1917] border border-zinc-800/50 rounded-md z-20">
                    <span class="text-[8px] font-black text-amber-500/70 uppercase tracking-[0.2em]">Análisis IA</span>
                  </div>

                  <div class="bg-black/40 rounded-xl p-4 pt-5 border border-zinc-800/50 h-24 overflow-y-auto custom-scroll transition-colors group-hover/analysis:border-amber-500/20">
                    <p class="text-[10px] text-zinc-500 italic leading-relaxed font-medium">
                      "{{ signal.reasoning }}"
                    </p>
                  </div>
                  
                  <div class="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-black/40 to-transparent rounded-b-xl pointer-events-none"></div>
                </div>
              </div>

              <div class="bg-[#241c18] border border-[#D4AF37]/10 rounded-xl p-4 mb-5">
                <div class="flex justify-between items-center mb-3">
                  <div class="flex flex-col">
                    <span class="text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]">Inversión Sugerida (5%)</span>
                    
                    <span class="text-sm font-mono font-bold transition-colors" 
                          :class="(signal.suggestedInversion > status.balanceUSDC || status.balancePOL < 0.1) ? 'text-red-500 animate-pulse' : 'text-white'">
                      {{ Number(signal.suggestedInversion || 0).toFixed(2) }}
                      <span class="text-[9px] text-[#D4AF37]">USDC</span>
                    </span>
                  </div>
                  
                  <div v-if="signal.suggestedInversion > status.balanceUSDC" class="bg-red-500/10 border border-red-500/20 px-2 py-1 rounded">
                    <span class="text-[7px] font-black text-red-500 uppercase">Fondos Insuficientes</span>
                  </div>
                </div>
                
                <div class="flex justify-between items-center border-t border-white/5 pt-3">
                  <div class="flex flex-col">
                    <span class="text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]">Retorno Neto Est.</span>
                    <span class="text-sm font-mono font-bold text-emerald-500">
                      +{{ Number(signal.potentialROI || 0).toFixed(2) }}<span class="text-[9px]">USDC</span>
                    </span>
                  </div>
                  <!-- Edge display: how much Claude is above market -->
                  <div class="flex flex-col items-end">
                    <span class="text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]">Edge vs Mercado</span>
                    <span v-if="signal.edge !== null && signal.edge !== undefined" 
                          class="text-sm font-mono font-bold"
                          :class="Number(signal.edge) >= 0.10 ? 'text-emerald-400' : Number(signal.edge) >= 0 ? 'text-zinc-400' : 'text-red-400'">
                      {{ Number(signal.edge) >= 0 ? '+' : '' }}{{ (Number(signal.edge || 0) * 100).toFixed(0) }}%
                    </span>
                    <span v-else class="text-xs text-zinc-600 font-mono">—</span>
                  </div>
                </div>
              </div>

              <div class="flex gap-3 mt-auto">
                <button 
                  @click="rejectSignal(signal.id)" 
                  class="flex-1 py-4 bg-zinc-800 border border-zinc-700 text-zinc-400 rounded-xl text-[10px] font-black hover:bg-red-950 hover:text-red-400 transition uppercase tracking-widest"
                >
                  IGNORAR
                </button>

                <button 
                  @click="approveSignal(signal)"
                  :disabled="!signal.conditionId || Number(signal.marketPrice) >= signal.probability"
                  class="flex-[2] py-4 rounded-xl font-black text-[10px] tracking-[0.2em] transition-all duration-300 flex flex-col items-center border"
                  :class="[
                    (!signal.conditionId || Number(signal.marketPrice) >= signal.probability)
                      ? 'bg-[#2A1D15] border-[#3C2A21] text-zinc-500 cursor-not-allowed'
                      : 'bg-[#D4AF37] border-[#D4AF37] text-[#3C2A21] hover:bg-transparent hover:text-[#D4AF37] shadow-lg'
                  ]"
                >
                  <div v-if="signal.conditionId" class="flex gap-4 mb-1 opacity-80 text-[9px]">
                    <span>IA: {{ (signal.probability * 100).toFixed(0) }}%</span>
                    <span>MKT: ${{ signal.marketPrice }}</span>
                    <span v-if="signal.endsIn">⏰ {{ signal.endsIn }}</span>
                  </div>

                  <template v-if="!signal.conditionId">
                    <span>SIN MERCADO ON-CHAIN</span>
                  </template>
                  <template v-else-if="Number(signal.marketPrice) >= signal.probability">
                    <span>SIN MARGEN DE GANANCIA</span>
                  </template>
                  <template v-else>
                    <span>EJECUTAR COMPRA</span>
                  </template>
                </button>
              </div>
            </div>
          </div>
        </div>
      
        <button 
        @click="runSniperTest" 
        :disabled="isTesting"
        class="bg-[#D4AF37] text-black font-black px-6 py-4 rounded-2xl hover:bg-white transition-all flex items-center gap-3 shadow-[0_0_20px_rgba(212,175,55,0.4)]"
      >
        <Loader2 v-if="isTesting" class="animate-spin" />
        <Target v-else />
        <span>EJECUTAR TEST-CLOB REAL</span>
      </button>

      <div class="bg-[#0f172a] border-2 border-cyan-500/40 rounded-3xl p-6 mb-8 shadow-[0_0_30px_rgba(6,182,212,0.1)] relative overflow-hidden group">
        <div class="flex items-center justify-between relative z-10">
          <div class="flex items-center gap-4">
            <div class="p-3 bg-cyan-500/10 rounded-2xl border border-cyan-500/30">
              <Cpu :size="24" class="text-cyan-400" />
            </div>
            <div>
              <h3 class="text-white font-black text-lg tracking-tight">Protocolo Test-Clob 2026</h3>
              <p class="text-[10px] text-cyan-400/70 uppercase font-bold tracking-[0.2em]">Valida Allowances + Firma L2 + Compra</p>
            </div>
          </div>
          
          <button 
            @click="runDeepTestClob" 
            :disabled="isDeepTesting"
            class="bg-cyan-600 hover:bg-cyan-500 text-white font-black px-6 py-3 rounded-xl transition-all active:scale-95 flex items-center gap-2 shadow-lg disabled:opacity-50"
          >
            <Loader2 v-if="isDeepTesting" class="animate-spin" :size="18" />
            <Play v-else :size="18" />
            <span>EJECUTAR TEST COMPLETO</span>
          </button>
        </div>
      </div>

        <div class="bg-[#1c1917] border-2 border-emerald-500/40 rounded-3xl p-6 mb-8 shadow-[0_0_30px_rgba(16,185,129,0.1)] relative overflow-hidden group">
          <div class="flex items-center justify-between relative z-10">
            <div class="flex items-center gap-4">
              <div class="p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/30 animate-pulse">
                <Target :size="24" class="text-emerald-500" />
              </div>
              <div>
                <h3 class="text-white font-black text-lg tracking-tight">Operación Especial: Ucrania Test</h3>
                <p class="text-[10px] text-emerald-500/70 uppercase font-bold tracking-[0.2em]">Ejecución Forzada via CLOB SigType 0</p>
              </div>
            </div>
            
            <button 
              @click="executeUkraineTest" 
              :disabled="isTestingUkraine"
              class="bg-emerald-500 hover:bg-emerald-400 text-black font-black px-6 py-3 rounded-xl transition-all active:scale-95 flex items-center gap-2 shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              <Loader2 v-if="isTestingUkraine" class="animate-spin" :size="18" />
              <Zap v-else :size="18" />
              <span>SNIPE 3.00 USDC</span>
            </button>
          </div>
        </div>

        <div class="bg-[#111114] border-2 border-cyan-500/20 rounded-3xl p-8 mb-8 shadow-[0_0_40px_rgba(6,182,212,0.05)] relative overflow-hidden group">
          <div class="absolute -right-10 -top-10 opacity-5 group-hover:opacity-10 transition-all duration-700 rotate-12">
            <Bot :size="200" class="text-cyan-500" />
          </div>

          <div class="flex flex-col md:flex-row md:items-center justify-between mb-8 relative z-10 gap-4">
            <div>
              <h2 class="text-cyan-400 font-black text-2xl tracking-tighter flex items-center gap-3">
                <Target :size="28" class="animate-pulse text-cyan-500" /> 
                RADAR DE INTELIGENCIA AUTOPILOT
              </h2>
              <p class="text-zinc-500 text-xs font-bold uppercase tracking-[0.3em] mt-1">
                Extracción en tiempo real • Algoritmos Rotativos
              </p>
            </div>
            
            <div class="flex flex-col items-end gap-1 bg-[#0b1215] border border-cyan-500/20 px-5 py-3 rounded-xl shadow-lg min-w-[300px]">
              <div class="flex items-center gap-2 mb-1 w-full justify-end">
                <div class="w-1.5 h-1.5 bg-cyan-500 rounded-full animate-ping"></div>
                <span class="text-cyan-400 text-[9px] font-black tracking-[0.2em] uppercase opacity-70">Tópico Activo</span>
              </div>
              
              <span class="text-white text-xs font-bold tracking-wide text-right leading-none max-w-[400px]">
                {{ getTopicName(status.currentTopic) }}
              </span>

              <div class="h-[1px] w-full bg-gradient-to-l from-cyan-500/30 to-transparent my-1"></div>

              <span class="text-zinc-400 text-[9px] font-mono font-medium text-right uppercase tracking-widest max-w-[400px]">
                Buscando ventanas de rentabilidad
              </span>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10">
            
            <template v-if="status.watchlist && status.watchlist.length > 0">
              <div v-for="(market, index) in status.watchlist.slice(0, 4)" :key="index"
                  class="bg-black/40 border border-zinc-800/50 p-5 rounded-2xl hover:bg-cyan-900/10 transition-all hover:border-cyan-500/30 flex flex-col justify-between">
                
                <div>
                  <div class="flex justify-between items-start mb-2">
                    <div class="flex items-center gap-2">
                      <span v-if="market.category === 'CRYPTO'" class="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-1">🪙 Cripto</span>
                      <span v-else-if="market.category === 'GEOPOLITICS'" class="text-[10px] font-black text-orange-400 uppercase tracking-widest flex items-center gap-1">🌍 Geo</span>
                      <span v-else-if="market.category === 'SOCIAL'" class="text-[10px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-1">📱 Social</span>
                      <span v-else class="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Pronóstico</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span v-if="market.endsIn" class="text-[9px] font-mono text-red-400 font-bold border border-red-500/20 px-1.5 py-0.5 rounded bg-red-500/10">
                        ⏰ {{ market.endsIn }}
                      </span>
                      <span v-if="market.conditionId" class="text-[9px] font-mono text-cyan-500 font-bold border border-cyan-500/30 px-1.5 py-0.5 rounded">
                        ON-CHAIN
                      </span>
                    </div>
                  </div>
                  
                  <p class="text-zinc-200 font-bold text-sm leading-tight mb-2 line-clamp-2" :title="market.title">
                    {{ market?.title || 'Analizando variables globales...' }}
                  </p>

                  <!-- Ocultamos el campo secundario para evitar redundancia -->
                  <p v-if="market?.title_es && market?.title_es !== market?.title" 
                     class="text-zinc-500 text-[10px] italic leading-snug font-medium line-clamp-1 border-l-2 border-cyan-900 pl-2">
                    {{ market?.title_es }}
                  </p>
                </div>

                <div class="flex items-center justify-between text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600 mt-3 pt-3 border-t border-zinc-800/50">
                  <span class="flex items-center gap-1">
                      <div class="w-1 h-1 bg-cyan-700 rounded-full animate-pulse"></div>
                      Evaluando Viabilidad
                  </span>
                  <span v-if="market.probability !== undefined" class="text-[11px] font-black bg-cyan-500/10 text-cyan-400 px-2 py-0.5 rounded border border-cyan-500/20 animate-pulse">
                    {{ (market.probability * 100).toFixed(0) }}%
                  </span>
                </div>
              </div>
            </template>

            <div v-else class="col-span-2 py-10 text-center text-zinc-700 font-mono text-xs border border-zinc-800 rounded-2xl border-dashed">
              <div class="animate-pulse">📡 Cargando modelos predictivos de la red neuronal...</div>
            </div>

          </div>
        </div>

        <!-- NUEVA SECCIÓN: NOTICIAS -->
        <div class="bg-[#111114] border-2 border-zinc-800 rounded-3xl p-8 mb-8 relative overflow-hidden group">
          <div class="absolute -right-10 -top-10 opacity-5 group-hover:opacity-10 transition-all duration-700 rotate-12">
            <Newspaper :size="200" class="text-zinc-500" />
          </div>

          <div class="flex items-center justify-between mb-6 relative z-10 border-b border-zinc-800/50 pb-4">
              <h2 class="text-white font-black text-xl flex items-center gap-3">
                <Newspaper :size="24" class="text-zinc-400" />
                Contexto de Noticias (En Vivo)
              </h2>
              <span class="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20 uppercase tracking-widest flex items-center gap-2">
                <div class="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                Feed Activo
              </span>
          </div>

          <div class="space-y-4 relative z-10">
            <template v-if="status.lastNews && status.lastNews.length > 0">
              <a v-for="(news, idx) in status.lastNews.slice(0, 5)" :key="idx" :href="news.link" target="_blank"
                 class="block bg-[#1c1917] hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 p-4 rounded-xl transition-all group/news">
                <p class="text-zinc-200 font-bold text-sm mb-1 group-hover/news:text-emerald-400 transition-colors line-clamp-2">
                  {{ news.title_es || news.title }}
                </p>
                <!-- Solo mostramos el original si hay una traducción arriba para evitar redundancia -->
                <p v-if="news.title_es" class="text-zinc-500 text-[10px] italic line-clamp-1 border-l-2 border-zinc-700 pl-2 mt-2">
                  {{ news.title }}
                </p>
              </a>
            </template>
            <div v-else class="text-center py-8 border border-zinc-800 border-dashed rounded-xl">
              <p class="text-zinc-500 font-mono text-sm animate-pulse">Recopilando fuentes de información...</p>
            </div>
          </div>
        </div>
      </div>

      <div class="col-span-12 xl:col-span-4 h-full space-y-6">

        <div class="bg-[#1c1917] border-2 border-[#D4AF37]/20 rounded-3xl p-5 flex items-center justify-between gap-6 shadow-xl relative overflow-hidden group">
          
          <div v-if="isThresholdUpdating" class="absolute inset-0 bg-black/40 backdrop-blur-[1px] z-20 flex items-center justify-center">
            <div class="flex items-center gap-2">
              <div class="w-1.5 h-1.5 bg-[#D4AF37] rounded-full animate-bounce"></div>
              <div class="w-1.5 h-1.5 bg-[#D4AF37] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
              <div class="w-1.5 h-1.5 bg-[#D4AF37] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
            </div>
          </div>

          <div class="shrink-0 relative z-10">
            <h3 class="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1">Filtro Sensibilidad</h3>
            <div class="flex items-baseline gap-1">
              <span class="text-[#D4AF37] font-mono text-2xl font-black leading-none" :class="{'opacity-50': isThresholdUpdating}">
                {{ ((status.predictionThreshold || 0) * 100).toFixed(0) }}
              </span>
              <span class="text-[#D4AF37] text-xs font-bold">%</span>
            </div>
          </div>
          
          <div class="flex-1 flex flex-col gap-2 relative z-10 px-2 justify-center">
            <input 
              type="range"
              min="0.10" 
              max="1.00" 
              step="0.05"
              v-model.number="status.predictionThreshold"
              @change="updateThreshold"
              :disabled="isThresholdUpdating"
              class="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
            />
            <div class="flex justify-between text-[8px] text-zinc-500 uppercase tracking-widest font-black px-1">
              <span class="hover:text-amber-500 cursor-pointer transition-colors" @click="setThreshold(0.10)">10% Riesgo</span>
              <span class="hover:text-emerald-500 cursor-pointer transition-colors" @click="setThreshold(0.90)">90% Seguro</span>
            </div>
          </div>
          
          <div class="text-[9px] font-black w-20 leading-tight uppercase text-center py-2 px-1 rounded-lg border transition-all duration-300 relative z-10"
              :class="status.predictionThreshold >= 0.7 
                  ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40'
                  : status.predictionThreshold <= 0.3 
                    ? 'text-red-500 bg-red-500/10 border-red-500/40' 
                    : 'text-amber-400 bg-amber-400/10 border-amber-400/40'">
            {{ isThresholdUpdating ? '...' : (status.predictionThreshold >= 0.7 ? 'MODO SEGURO' : (status.predictionThreshold <= 0.3 ? 'EXTREMO' : 'REGULAR')) }}
          </div>
        </div>

        <div class="bg-[#1c1917] border-2 border-emerald-500/20 hover:border-emerald-500/50 rounded-3xl p-6 transition-all shadow-xl relative overflow-hidden group">
          <div class="absolute -right-6 -top-6 opacity-5 group-hover:opacity-10 transition-all duration-700">
            <Cpu :size="120" class="text-emerald-500" />
          </div>
          
          <div class="relative z-10 flex items-center justify-between mb-4 pb-4 border-b border-zinc-800">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                <Cpu :size="20" class="text-emerald-500" />
              </div>
              <div>
                <h3 class="text-white font-black text-sm tracking-wide">Autopilot AI Trade</h3>
                <p class="text-[10px] text-zinc-500 uppercase tracking-widest mt-0.5">Micro-Transacciones</p>
              </div>
            </div>
            
            <label class="relative inline-flex items-center cursor-pointer group/toggle">
              <input type="checkbox" v-model="status.autoTradeEnabled" @change="updateAutoTrade" class="sr-only peer">
              <div class="w-11 h-6 bg-zinc-800 rounded-full peer peer-focus:ring-2 peer-focus:ring-emerald-500/20 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-300 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 group-hover/toggle:shadow-[0_0_15px_rgba(16,185,129,0.3)]"></div>
            </label>
          </div>

          <div class="relative z-10 flex items-center justify-between bg-black/40 p-3 rounded-2xl border border-zinc-800 focus-within:border-emerald-500/30">
            <div class="flex flex-col">
              <span class="text-[9px] text-zinc-500 font-black uppercase tracking-widest pl-2 mb-1">Inversión x Señal</span>
              <div class="flex items-center gap-2 px-2">
                <span class="text-emerald-500 font-bold">$</span>
                <input 
                  type="number" 
                  v-model.number="status.microBetAmount" 
                  @change="updateAutoTrade"
                  min="0.5" 
                  step="0.5"
                  class="bg-transparent text-white font-mono text-xl w-24 focus:outline-none placeholder:text-zinc-700 disabled:cursor-not-allowed" 
                  :disabled="!status.autoTradeEnabled"
                  :class="{'opacity-50': !status.autoTradeEnabled}"
                />
              </div>
            </div>
            <div class="text-[10px] font-black flex items-center gap-2 uppercase border border-zinc-800 px-3 py-1.5 rounded-lg text-zinc-400 bg-zinc-900 transition-colors" :class="status.autoTradeEnabled ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' : ''">
              <div v-if="status.autoTradeEnabled" class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span>{{ status.autoTradeEnabled ? 'ACTIVO' : 'INACTIVO' }}</span>
            </div>
          </div>
        </div>
  
        <div class="bg-[#111114] border-2 border-[#D4AF37]/30 rounded-3xl p-6 shadow-xl relative overflow-hidden group">
          <div class="absolute -right-4 -top-4 opacity-10 group-hover:rotate-12 transition-transform duration-500">
            <RefreshCcw :size="80" class="text-[#D4AF37]" />
          </div>

          <div class="relative z-10">
            <h3 class="text-[#D4AF37] font-black text-xs uppercase tracking-[0.3em] mb-6 flex items-center gap-3">
              <div class="p-2 bg-[#D4AF37]/10 rounded-lg">
                <RefreshCcw :size="14" class="text-[#D4AF37] animate-spin-slow" />
              </div>
              Gestión de Liquidez
            </h3>

            <div class="space-y-6">
              <div class="bg-black/40 border border-zinc-800 rounded-3xl p-1.5 transition-all focus-within:border-[#D4AF37]/50 focus-within:ring-1 focus-within:ring-[#D4AF37]/20">
                
                <div class="flex items-center justify-between p-4 bg-zinc-900/50 rounded-2xl mb-1">
                  <div class="flex flex-col">
                    <span class="text-[9px] text-zinc-500 font-black uppercase mb-1 ml-1 tracking-widest">Vendes</span>
                    <input 
                      v-model.number="swapAmount" 
                      type="number" 
                      placeholder="0.00"
                      class="bg-transparent text-white font-mono text-2xl focus:outline-none w-full placeholder:text-zinc-800"
                      style="-moz-appearance: textfield; appearance: none;" 
                    />
                  </div>
                  <div class="flex flex-col items-end shrink-0">
                    <div class="flex items-center gap-2 bg-black px-3 py-1.5 rounded-xl border border-zinc-800">
                      <div class="w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center text-[8px] font-bold text-white">P</div>
                      <span class="text-xs font-black text-white uppercase tracking-tighter">POL</span>
                    </div>
                    <span class="text-[9px] text-zinc-600 mt-1 mr-1">Saldo: {{ status.balancePOL }}</span>
                  </div>
                </div>

                <div class="flex justify-center -my-3 relative z-20">
                  <div class="bg-zinc-800 p-1.5 rounded-full border-4 border-[#111114]">
                    <ArrowDown :size="12" class="text-[#D4AF37]" />
                  </div>
                </div>

                <div class="flex items-center justify-between p-4 bg-zinc-900/50 rounded-2xl">
                  <div class="flex flex-col">
                    <span class="text-[9px] text-zinc-500 font-black uppercase mb-1 ml-1 tracking-widest">Recibes</span>
                    <div class="font-mono text-2xl text-[#D4AF37] opacity-90">
                      {{ swapAmount > 0 ? estimatedUsdc : '0.00' }}
                    </div>
                  </div>
                  <div class="flex flex-col items-end shrink-0">
                    <div class="flex items-center gap-2 bg-black px-3 py-1.5 rounded-xl border border-zinc-800">
                      <div class="w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center text-[8px] font-bold text-white">S</div>
                      <span class="text-xs font-black text-white uppercase tracking-tighter">USDC NATIVE</span>
                    </div>
                    <span class="text-[9px] text-zinc-600 mt-1 mr-1">Aprox.</span>
                  </div>
                </div>
              </div>

              <button 
                @click="executeSwap"
                :disabled="isSwapping || swapAmount <= 0 || swapSuccess"
                class="w-full py-4 rounded-2xl font-black text-xs transition-all duration-300 flex flex-col items-center justify-center gap-0.5"
                :class="[
                  insufficientFunds ? 'bg-red-950/40 text-red-500 border border-red-500/50' : 
                  swapSuccess ? 'bg-green-600/20 text-green-400 border border-green-500/30' : 
                  'bg-[#D4AF37] text-[#3C2A21]'
                ]"
              >
                <template v-if="insufficientFunds">
                  <span class="uppercase tracking-widest">Saldo Insuficiente</span>
                </template>

                <template v-else-if="swapSuccess">
                  <div class="flex items-center gap-2">
                    <Check :size="16" />
                    <span class="uppercase tracking-widest">¡ORDEN ENVIADA!</span>
                  </div>
                </template>

                <template v-else-if="isSwapping">
                  <div class="flex items-center gap-2">
                    <Loader2 class="animate-spin" :size="16" />
                    <span>PROCESANDO...</span>
                  </div>
                </template>

                <template v-else>
                  <span class="uppercase tracking-widest">Ejecutar Conversión</span>
                </template>
              </button>
              
              <div class="flex items-center justify-center gap-2 opacity-40">
                <div class="h-px w-8 bg-zinc-800"></div>
                <p class="text-[8px] text-zinc-500 font-bold uppercase tracking-widest italic">Gas: ~0.02 POL</p>
                <div class="h-px w-8 bg-zinc-800"></div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="bg-[#111114] border-2 border-zinc-800 rounded-3xl p-6 shadow-2xl sticky top-8 flex flex-col h-[calc(100vh-8rem)]">
          <div class="flex items-center gap-2.5 mb-6 border-b border-zinc-800/50 pb-4">
            <Zap :size="20" class="text-emerald-500" />
            <span class="font-extrabold text-lg text-white tracking-tight">Registro de Ejecuciones</span>
          </div>
          
          <div class="space-y-5 overflow-y-auto pr-3 custom-scroll flex-grow">
            <div v-for="ex in status.executions" :key="ex.id" class="p-5 bg-zinc-900 rounded-2xl border-l-4 border border-zinc-800 transition-all hover:border-emerald-700 shadow-md" :class="ex.id ? 'border-l-emerald-600' : 'border-l-zinc-700'">
              <div class="flex justify-between items-center mb-2">
                <div class="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 :size="14" />
                    <span class="text-[11px] font-bold tracking-widest uppercase">BUY ORDER</span>
                </div>
                <span class="text-[10px] text-zinc-600 font-mono">{{ ex.date }}</span>
              </div>
              <p class="text-sm text-zinc-100 font-medium leading-snug mb-3">{{ ex.market }}</p>
              <div class="flex justify-between items-end gap-2 border-t border-zinc-800 pt-3 mt-1">
                <p class="text-[10px] font-mono text-zinc-600 truncate italic">ID: {{ ex.id }}</p>
                <p class="text-xl font-black text-white leading-none whitespace-nowrap">${{ ex.price.toFixed(2) }} <span class="text-xs text-zinc-500 font-medium">USDC</span></p>
              </div>
            </div>

            <div v-if="status.executions.length === 0" class="text-center text-zinc-700 text-sm py-20 flex flex-col items-center gap-4">
                <Activity :size="40" class="text-zinc-800" />
                Esperando la primera oportunidad de trading...
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