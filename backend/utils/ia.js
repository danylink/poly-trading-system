// utils/ia.js
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const grokClient = new OpenAI({ apiKey: process.env.GROK_API_KEY, baseURL: "https://api.x.ai/v1" });

// ==========================================
// 3A. MOTOR DE IA 1 (CLAUDE) - Versión Cuantitativa Anti-Alucinación
// ==========================================
export async function analyzeMarketWithClaude(marketQuestion, currentNews, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 180,
                system: `Eres un Senior Quant Trader especializado en Polymarket.

TUS INSTRUCCIONES:
Analiza el mercado específico usando SOLO las noticias proporcionadas.

REGLAS ANTI-ALUCINACIÓN (ESTRICTAS):
1. AISLAMIENTO DE CONTEXTO: Tu análisis debe tratar EXCLUSIVAMENTE sobre el tema del mercado. No inventes conexiones con la inflación, la Fed, Trump o la geopolítica si el mercado no los menciona explícitamente.
2. RIGOR ESTADÍSTICO: No infles probabilidades. Si las noticias no te dan una ventaja matemática clara, tu probabilidad debe ser conservadora (ej. 0.50) y tu recomendación "WAIT".
3. CONCISIÓN: Tu "reason" debe ser lógica, directa y referirse 100% al mercado en cuestión.

Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`,
                messages: [{ role: "user", content: `Mercado a analizar: "${marketQuestion}"\nNoticias Recientes: "${currentNews}"\nAnaliza la ventaja real en las próximas 96 horas.` }]
            });

            const jsonMatch = response.content[0].text.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("JSON inválido");
            const data = JSON.parse(jsonMatch[0]);

            return { 
                isError: false, 
                prob: parseFloat(data.prob) || 0, 
                strategy: data.strategy || "WAIT", 
                urgency: data.urgency || 5, 
                reason: data.reason || "Sin ventaja", 
                edge: parseFloat(data.edge) || 0, 
                recommendation: data.recommendation || "WAIT" 
            };

        } catch (error) {
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue; 
            }
            return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error Claude", edge: 0, recommendation: "WAIT" };
        }
    }
}

// ==========================================
// 3B. MOTOR DE IA 2 (GEMINI) - Versión Anti-Alucinación y Resiliente
// ==========================================
export async function analyzeMarketWithGemini(marketQuestion, currentNews, retries = 2) {
    console.log("🧠 Gemini Short-Term Analysis...");
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const prompt = `Eres un Senior Quant Trader especializado en Polymarket.

TUS INSTRUCCIONES:
Analiza ESTE mercado específico usando SOLO las noticias proporcionadas.

Mercado a analizar: "${marketQuestion}"
Noticias Recientes: "${currentNews}"

REGLAS ANTI-ALUCINACIÓN (ESTRICTAS):
1. AISLAMIENTO DE CONTEXTO: Tu análisis debe tratar EXCLUSIVAMENTE sobre el tema del mercado. No inventes conexiones con la inflación, la Fed, Trump o la geopolítica si el mercado no los menciona explícitamente.
2. RIGOR ESTADÍSTICO: No infles probabilidades. Si las noticias no te dan una ventaja matemática clara, tu probabilidad debe ser conservadora (ej. 0.50) y tu recomendación "WAIT".
3. CONCISIÓN: Tu "reason" debe ser lógica, directa y referirse 100% al mercado en cuestión.

Responde ESTRICTAMENTE con este JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`;

            const result = await geminiModel.generateContent(prompt);
            const responseText = result.response.text().trim();
            const jsonMatch = responseText.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("JSON inválido");
            const data = JSON.parse(jsonMatch[0]);

            return {
                isError: false,
                prob: parseFloat(data.prob) || 0,
                strategy: data.strategy || "WAIT",
                urgency: data.urgency || 5,
                reason: data.reason || "Sin ventaja clara",
                edge: parseFloat(data.edge) || 0,
                recommendation: data.recommendation || "WAIT"
            };

        } catch (error) {
            // Si es un error de sobrecarga (503) y nos quedan intentos, esperamos y reintentamos
            const isOverloaded = error.message.includes('503') || error.message.includes('429');
            if (isOverloaded && attempt < retries) {
                console.log(`⚠️ Gemini saturado (Intento ${attempt}/${retries}). Esperando 3s...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue;
            }
            
            console.error("❌ Error en motor Gemini:", error.message);
            return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error Gemini API", edge: 0, recommendation: "WAIT" };
        }
    }
}

// ==========================================
// 3C. MOTOR DE IA 3 (GROK) - Versión Cuantitativa Anti-Alucinación
// ==========================================
export async function analyzeMarketWithGrok(marketQuestion, currentNews, retries = 2) {
    console.log("🧠 Grok Short-Term Analysis...");
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await grokClient.chat.completions.create({
                model: "grok-4-1-fast-non-reasoning",
                messages: [
                    {
                        role: "system",
                        content: `Eres un Senior Quant Trader especializado en Polymarket.

TUS INSTRUCCIONES:
Analiza el mercado específico usando SOLO las noticias proporcionadas.

REGLAS ANTI-ALUCINACIÓN (ESTRICTAS):
1. AISLAMIENTO DE CONTEXTO: Tu análisis debe tratar EXCLUSIVAMENTE sobre el tema del mercado. No inventes conexiones con la inflación, la Fed, Trump o la geopolítica si el mercado no los menciona explícitamente.
2. RIGOR ESTADÍSTICO: No infles probabilidades. Si las noticias no te dan una ventaja matemática clara, tu probabilidad debe ser conservadora (ej. 0.50) y tu recomendación "WAIT".
3. CONCISIÓN: Tu "reason" debe ser lógica, directa y referirse 100% al mercado en cuestión.

Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`
                    },
                    {
                        role: "user",
                        content: `Mercado a analizar: "${marketQuestion}"\nNoticias Recientes: "${currentNews}"\nAnaliza la ventaja real en las próximas 96 horas.`
                    }
                ],
                response_format: { type: "json_object" }
            });

            const data = JSON.parse(response.choices[0].message.content);

            return {
                isError: false,
                prob: parseFloat(data.prob) || 0,
                strategy: data.strategy || "WAIT",
                urgency: data.urgency || 5,
                reason: data.reason || "Sin ventaja clara",
                edge: parseFloat(data.edge) || 0,
                recommendation: data.recommendation || "WAIT"
            };
        } catch (error) {
            const isOverloaded = error.status === 429 || error.status >= 500;
            if (isOverloaded && attempt < retries) {
                console.log(`⚠️ Grok saturado (Intento ${attempt}/${retries}). Esperando 3s...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue;
            }
            console.error("❌ Error en motor Grok:", error.message);
            return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error Grok API", edge: 0, recommendation: "WAIT" };
        }
    }
}