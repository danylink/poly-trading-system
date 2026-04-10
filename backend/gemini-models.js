import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// 👇 INICIALIZAR GEMINI (Global)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

// Usamos 'let' porque inyectaremos el modelo dinámicamente al arrancar el servidor
let geminiModel = null;

// ==========================================
// 🤖 AUTO-SELECTOR DE MODELO GEMINI
// ==========================================
async function initGemini() {
    try {
        console.log("🔍 [GEMINI] Buscando el modelo estable más rápido en la nube...");
        const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
        
        const response = await axios.get(url);
        const models = response.data.models;

        let selectedModelName = null;

        for (const model of models) {
            const shortName = model.name.replace('models/', '');
            
            // 🔥 MAGIA QUANT: Expresión regular que busca estrictamente "gemini-X.X-flash"
            // (Ignorará automáticamente versiones 'pro', 'preview' o 'lite')
            if (/^gemini-\d+\.\d+-flash$/.test(shortName)) {
                selectedModelName = shortName;
                break; // Tomamos el primero de la lista (Google siempre pone el más nuevo arriba)
            }
            
            // Fallback en caso de que Google cambie la convención de nombres
            if (shortName === 'gemini-flash-latest' && !selectedModelName) {
                selectedModelName = shortName;
            }
        }

        // Fallback duro por seguridad extrema
        if (!selectedModelName) {
            selectedModelName = 'gemini-2.5-flash'; 
        }

        console.log(`✅ [GEMINI] Modelo inicializado exitosamente: ${selectedModelName}`);

        // Inyectamos el modelo seleccionado a la variable global de nuestro bot
        geminiModel = genAI.getGenerativeModel({ 
            model: selectedModelName,
            generationConfig: {
                responseMimeType: "application/json"
            }
        });

    } catch (error) {
        console.error("❌ [GEMINI] Error en auto-selección, forzando gemini-2.5-flash:", error.message);
        geminiModel = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            generationConfig: {
                responseMimeType: "application/json"
            }
        });
    }
}

initGemini();