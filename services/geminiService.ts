import { GoogleGenAI, Type, Schema, Modality } from "@google/genai";
import { BackgroundAsset } from '../types';

// Utility to get API key safely - works with Vite, CRA, and Node.js
const getApiKey = (): string => {
  // Vite (import.meta.env.VITE_*)
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_KEY) {
    return import.meta.env.VITE_API_KEY;
  }

  // Vite alternative naming
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GEMINI_API_KEY) {
    return import.meta.env.VITE_GEMINI_API_KEY;
  }

  // Create React App (process.env.REACT_APP_*)
  if (typeof process !== 'undefined' && process.env?.REACT_APP_API_KEY) {
    return process.env.REACT_APP_API_KEY;
  }

  if (typeof process !== 'undefined' && process.env?.REACT_APP_GEMINI_API_KEY) {
    return process.env.REACT_APP_GEMINI_API_KEY;
  }

  // Node.js / SSR fallback
  if (typeof process !== 'undefined' && process.env?.API_KEY) {
    return process.env.API_KEY;
  }

  if (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }

  console.error("API Key missing. Set VITE_API_KEY (Vite) or REACT_APP_API_KEY (CRA) in your .env file.");
  return "";
};

export const generateBackgroundAssets = async (
  userPrompt: string,
  category?: string,
  subcategory?: string,
  styleReference?: BackgroundAsset
): Promise<BackgroundAsset[]> => {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("Cannot generate assets: API key is missing");
    return [];
  }

  const ai = new GoogleGenAI({ apiKey });

  // 1. First, generate the metadata (Prompt, Title, Tags, etc.)
  let systemInstruction = `
    You are an expert Art Director for a UI/UX design platform.
    Your task is to generate detailed image generation prompts for website assets based on a user's theme or concept.
    The assets must be "lightly stylized realism" - think high-quality AI stock photos mixed with a brand aesthetic.

    IMPORTANT:
    1. If the user request implies a physical product (e.g., "skincare", "coffee", "tech gadgets"), create a "Product & Scene Photography" prompt. Describe a flat lay or studio scene with props, realistic materials, and lighting.
    2. If the user explicitly asks for a specific quantity (e.g. "10 images", "5 backgrounds"), generate exactly that many unique variations.
    3. If no quantity is specified, generate 1 asset.
    4. Classify the asset category:
       - "background": For abstract, textures, gradients, or scenery with ample negative space, primarily used behind text.
       - "image": For product shots, specific subject focus, complex scenes, or flat lays.
       - "icon": For simple graphical elements or isolated symbols.
    5. Classify the asset subcategory into exactly one of these: "Beauty", "Food & Beverage", "Fashion", "Pets", "Seasons", "Home", "Travel", "Tech". Choose the most relevant one.

    They must be suitable for mobile and desktop (responsive), meaning they need "safe areas" or composition that handles cropping well.
  `;

  // Inject Style Reference instructions if provided
  if (styleReference) {
    systemInstruction += `

    CRITICAL STYLE OVERRIDE:
    The user wants to create a new asset that STRICTLY MATCHES the visual style of a reference asset.

    Reference Style Attributes to Mimic:
    - Visual Style: ${styleReference.style.join(', ')}
    - Lighting: ${styleReference.lighting}
    - Composition: ${styleReference.composition}
    - Negative Prompt: ${styleReference.negative_prompt}

    Your generated prompt MUST:
    1. Use the SAME rendering style (e.g., if reference is "line art", generate "line art"; if "photorealistic", generate "photorealistic").
    2. Use the SAME lighting and color grading mood.
    3. Apply these style constraints to the new subject described in the user prompt: "${userPrompt}".
    `;
  }

  let constraintText = "";
  if (category && category !== 'all') {
    constraintText += ` The asset category MUST be "${category}".`;
  }
  if (subcategory && subcategory !== 'all') {
    constraintText += ` The asset subcategory MUST be "${subcategory}".`;
  }

  const textPrompt = `Create background asset definitions for the request: "${userPrompt}".${constraintText}
  Ensure the prompts are descriptive.
  The IDs should be unique and snake_case.
  Size should be 1080x1920.
  Preview color should be valid CSS.
  `;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      assets: {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              theme: { type: Type.STRING },
              title: { type: Type.STRING },
              size: { type: Type.STRING, enum: ["1080x1920"] },
              format: { type: Type.STRING, enum: ["webp", "png", "jpg"] },
              prompt: { type: Type.STRING },
              negative_prompt: { type: Type.STRING },
              style: { type: Type.ARRAY, items: { type: Type.STRING } },
              lighting: { type: Type.STRING },
              composition: { type: Type.STRING },
              tags: { type: Type.ARRAY, items: { type: Type.STRING } },
              previewColor: { type: Type.STRING, description: "A CSS color string (hex or gradient) that represents the image dominant colors" },
              category: { type: Type.STRING, enum: ["background", "image", "icon"], description: "Classify if this is a generic background, a specific product/scene image, or an icon." },
              subcategory: {
                type: Type.STRING,
                enum: ["Beauty", "Food & Beverage", "Fashion", "Pets", "Seasons", "Home", "Travel", "Tech"],
                description: "The industry or vertical this asset belongs to."
              }
            },
            required: ["id", "theme", "title", "size", "format", "prompt", "negative_prompt", "style", "lighting", "composition", "tags", "previewColor", "category", "subcategory"],
        }
      }
    }
  };

  try {
    // Step 1: Generate Metadata Batch
    const metaResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: textPrompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });

    const text = metaResponse.text;
    if (!text) return [];

    const parsed = JSON.parse(text) as { assets: BackgroundAsset[] };
    const assetList = parsed.assets || [];

    // Step 2: Generate Actual Images Serially (Rate Limit Safety)
    const assetsWithImages: BackgroundAsset[] = [];

    for (const asset of assetList) {
        try {
            // If a style reference exists, we prepend style keywords to the image prompt to ensure the model picks it up visually
            const stylePrefix = styleReference ? `${styleReference.style.join(', ')} style. ` : '';

            const imageResponse = await ai.models.generateContent({
              model: 'gemini-2.5-flash-image',
              contents: {
                parts: [
                  {
                    text: stylePrefix + asset.prompt,
                  },
                ],
              },
              config: {
                responseModalities: ['IMAGE' as Modality],
              },
            });

            const candidates = imageResponse.candidates;
            if (candidates && candidates[0]?.content?.parts) {
                for (const part of candidates[0].content.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        asset.imageBase64 = `data:image/png;base64,${part.inlineData.data}`;
                        break;
                    }
                }
            }

            // Rate Limit Buffer: Wait 1.5 seconds between image requests to avoid 429s
            await new Promise(resolve => setTimeout(resolve, 1500));

        } catch (imageError) {
            console.error(`Failed to generate image for ${asset.id}`, imageError);
            // We return the asset anyway, it will just fall back to CSS gradient preview
        }
        assetsWithImages.push(asset);
    }

    return assetsWithImages;

  } catch (error) {
    console.error("Error generating background assets:", error);
    return [];
  }
};
