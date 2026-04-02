<script setup>
import { ref, onMounted, computed, onUnmounted } from 'vue'
import axios from 'axios'
import { 
  Activity, ShieldCheck, Target, Cpu, Bot, Clock3, Power, ArrowUpRight
} from 'lucide-vue-next'

const API_URL = 'http://localhost:3001/api';

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
  autoTradeEnabled: false,
  microBetAmount: 1.00,
  predictionThreshold: 0.70
})

const isAutoTradeUpdating = ref(false);
const isThresholdUpdating = ref(false);
let pollingInterval = null;

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

// --- COMPUTED PROPERTIES ---

const probColor = computed(() => {
  const p = status.value.lastProbability;
  if (p >= 0.80) return 'text-[#D4AF37] drop-shadow-[0_0_10px_rgba(212,175,55,0.4)] font-black';
  if (p >= 0.60) return 'text-amber-500/80 font-bold';
  return 'text-zinc-500';
});

// --- CICLO DE VIDA ---

onMounted(() => {
  fetchStatus();
  // Polling de 3 segundos para balance y signals (más eficiente que 5)
  pollingInterval = setInterval(fetchStatus, 3000);
});

onUnmounted(() => {
  if (pollingInterval) clearInterval(pollingInterval);
});
</script>

<template>
  <div class="min-h-screen bg-[#09090b] text-zinc-300 font-sans p-4 md:p-8 selection:bg-emerald-500/20 selection:text-emerald-300">

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
        
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4"> <div class="bg-[#1c1917] border-2 border-[#D4AF37] p-5 rounded-3xl shadow-[0_0_20px_rgba(212,175,55,0.2)] relative overflow-hidden group">
            <div class="absolute -right-6 -top-6 opacity-10"><Target :size="80" class="text-[#D4AF37]" /></div>
            <p class="text-[9px] uppercase font-black text-[#D4AF37] tracking-widest mb-1">Polymarket Capital</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-3xl font-extrabold text-white font-mono">${{ status.clobOnlyUSDC || status.balanceUSDC }}</h3>
              <span class="text-[10px] text-zinc-500 font-bold">USDC</span>
            </div>
            <p class="text-[8px] text-zinc-500 mt-2 uppercase tracking-tighter italic">Listo para operar</p>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl hover:border-blue-900/50 transition-all">
            <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">MetaMask Wallet</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-2xl font-bold text-zinc-200 font-mono">${{ status.walletOnlyUSDC }}</h3>
              <span class="text-[10px] text-zinc-600 font-bold">USDC</span>
            </div>
            <div class="mt-2 flex items-center gap-1 text-[8px] text-blue-500/70 font-bold uppercase">
              <ArrowUpRight :size="10" /> Fondos en reserva
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl">
            <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">Gas Network</p>
            <div class="flex items-baseline gap-1">
              <h3 class="text-2xl font-bold text-zinc-200 font-mono">{{ status.balancePOL }}</h3>
              <span class="text-[10px] text-zinc-600 font-bold">POL</span>
            </div>
          </div>

          <div class="bg-[#111114] border border-zinc-800 p-5 rounded-3xl relative overflow-hidden">
            <p class="text-[9px] uppercase font-black text-zinc-500 tracking-widest mb-1">IA Confidence</p>
            <h3 class="text-2xl font-bold font-mono" :class="probColor">{{ (status.lastProbability * 100).toFixed(1) }}%</h3>
          </div>

        </div>

        <div class="mt-8 bg-[#1C1612] border border-[#3C2A21] rounded-2xl overflow-hidden shadow-lg">
          <div class="p-6 border-b border-[#3C2A21] flex justify-between items-center bg-[#251B15]">
            <h3 class="text-[#D4AF37] font-black text-xs tracking-widest uppercase flex items-center gap-2">
              <div class="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse"></div>
              Historial de Ejecuciones (Polymarket)
            </h3>
            <span class="text-[10px] text-zinc-500 font-mono">LIVE TRACKING</span>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-[10px] text-zinc-500 uppercase tracking-tighter border-b border-[#3C2A21]">
                  <th class="p-4 font-medium">Mercado</th>
                  <th class="p-4 font-medium">Inversión Real</th>
                  <th class="p-4 font-medium">Cuota</th>
                  <th class="p-4 font-medium">Pago Potencial</th>
                  <th class="p-4 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody class="text-xs">
                <tr v-for="exec in status.executions" :key="exec.id" class="border-b border-[#3C2A21]/50 hover:bg-[#2A1D15] transition-colors">
                  <td class="p-4">
                    <div class="font-bold text-zinc-200 line-clamp-1">{{ exec.market }}</div>
                    <span class="text-[9px] text-[#D4AF37] font-mono uppercase tracking-tighter">{{ exec.time }} | ID: {{ exec.id }}</span>
                  </td>
                  
                  <td class="p-4 text-zinc-300 font-mono font-bold">
                    ${{ exec.inversion?.toFixed(2) || '0.00' }}
                  </td>

                  <td class="p-4 text-[#D4AF37] font-mono">
                    ${{ exec.price?.toFixed(3) || '0.000' }}
                  </td>

                  <td class="p-4 font-mono">
                    <div class="font-bold" :class="(exec.pnlUsdc || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                      ${{ exec.valorActual?.toFixed(2) || '0.00' }}
                    </div>
                    <div v-if="exec.pnlUsdc !== undefined" class="text-[9px] font-bold opacity-80" :class="exec.pnlUsdc >= 0 ? 'text-emerald-500' : 'text-rose-500'">
                      {{ exec.pnlUsdc >= 0 ? '+' : '' }}${{ exec.pnlUsdc?.toFixed(2) }} ({{ exec.pnlPct?.toFixed(1) }}%)
                    </div>
                  </td>

                  <td class="p-4 font-mono font-bold text-emerald-500 text-[10px]">{{ exec.status }}</td>
                </tr>
                <tr v-if="!status.executions || status.executions.length === 0">
                  <td colspan="5" class="p-12 text-center text-zinc-600 italic">No hay disparos registrados aún.</td>
                </tr>
              </tbody>
            </table>
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
                  <span v-if="signal.endsIn" class="text-[9px] text-red-400 font-bold font-mono">⏰ {{ signal.endsIn }}</span>
                </div>
                <p class="text-white font-bold text-sm leading-tight mb-4 line-clamp-3" :title="signal.marketName">{{ signal.marketName }}</p>
                <div class="bg-black/40 rounded-xl p-4 border border-zinc-800/50 h-20 overflow-y-auto custom-scroll mb-4">
                  <p class="text-[10px] text-zinc-500 italic leading-relaxed font-medium">"{{ signal.reasoning }}"</p>
                </div>
              </div>
              
              <div class="flex justify-between items-center bg-[#241c18] border border-[#D4AF37]/10 rounded-xl p-3 mb-4">
                <div class="flex flex-col">
                  <span class="text-[8px] font-black text-zinc-500 uppercase">Edge vs Mercado</span>
                  <span class="text-sm font-mono font-bold" :class="Number(signal.edge) >= 0.10 ? 'text-emerald-400' : 'text-zinc-400'">
                    {{ Number(signal.edge) >= 0 ? '+' : '' }}{{ (Number(signal.edge || 0) * 100).toFixed(0) }}%
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
                  <span class="text-[8px] opacity-70 font-mono">MKT: ${{ signal.marketPrice }} | IA: {{ (signal.probability * 100).toFixed(0) }}%</span>
                </template>
              </button>
            </div>
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

      </div>

      <div class="col-span-12 xl:col-span-4 h-full space-y-6">

        <div class="bg-[#1c1917] border-2 border-[#D4AF37]/20 rounded-3xl p-5 flex items-center justify-between gap-6 shadow-xl relative overflow-hidden group">
          
          <div class="shrink-0 relative z-10">
            <h3 class="text-[10px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-1">Filtro Sensibilidad</h3>
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
              min="0.10" max="0.95" step="0.05"
              v-model.number="status.predictionThreshold"
              @change="updateThreshold"
              class="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
            />
            <div class="flex justify-between text-[8px] text-zinc-500 uppercase tracking-widest font-black px-1">
              <span class="hover:text-amber-500 cursor-pointer transition-colors" @click="setThreshold(0.50)">50% Riesgo</span>
              <span class="hover:text-emerald-500 cursor-pointer transition-colors" @click="setThreshold(0.85)">85% Seguro</span>
            </div>
          </div>
          
          <div class="text-[9px] font-black w-24 leading-tight uppercase text-center py-2 px-1 rounded-lg border transition-all duration-300 relative z-10"
              :class="(status.predictionThreshold || 0.70) >= 0.75 
                  ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/40'
                  : (status.predictionThreshold || 0.70) <= 0.40 
                    ? 'text-red-500 bg-red-500/10 border-red-500/40' 
                    : 'text-amber-400 bg-amber-400/10 border-amber-400/40'">
            {{ (status.predictionThreshold || 0.70) >= 0.75 ? 'MODO SEGURO' : ((status.predictionThreshold || 0.70) <= 0.40 ? 'ALTO RIESGO' : 'ESTÁNDAR') }}
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