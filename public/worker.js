// Worker : charge multilingual-e5-small (quantifié q8) et encode les phrases de l'utilisateur.
// Les vecteurs du catalogue sont déjà calculés (scripts/embed.mjs) : ici on n'encode que la requête.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

env.allowLocalModels = false; // les poids viennent du Hugging Face Hub, mis en cache par le navigateur

const MODEL = 'Xenova/multilingual-e5-small';
let extractor = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      extractor = await pipeline('feature-extraction', MODEL, {
        dtype: 'q8',
        progress_callback: (p) => self.postMessage({ type: 'progress', p }),
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'embed') {
      const out = await extractor(`query: ${data.text}`, { pooling: 'mean', normalize: true });
      self.postMessage({ type: 'vec', id: data.id, vec: Float32Array.from(out.data) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err?.message ?? err) });
  }
};
