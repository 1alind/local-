# Gemma 4 E2B Web

A static, browser-only interface for running Google's Gemma 4 E2B WEB LiteRT-LM model with WebGPU.

## GitHub Pages deployment

This branch is prepared for GitHub Pages:

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select branch **gemma-pages** and folder **/(root)**, then save.
4. Wait for GitHub Pages to publish the site. The Pages URL appears in that settings panel.

The site entry point is `index.html`. It uses a relative script path, so it works at the repository's project-site URL.

## Use

1. Open the published HTTPS Pages URL in a browser with WebGPU support.
2. Download the **Gemma 4 E2B WEB** `.litertlm` model file separately.
3. Choose that file in the page and press **Load selected model**.
4. Start chatting after the model loads.

Model file: [Gemma 4 E2B WEB on Hugging Face](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/Gemma-4-E2B-it-web.litertlm)

The model is selected from local device storage using the browser file picker. This website does not host, download, or upload model weights. Inference runs in the browser through WebGPU.

## Requirements and limits

- A modern browser with WebGPU support and a compatible GPU.
- Enough device memory for the model and runtime.
- Internet access is needed to load the LiteRT-LM JavaScript runtime from jsDelivr.
- This is text-in / text-out only. Image and audio input are not implemented here.
- GitHub Pages serves the site over HTTPS automatically. No Termux server, local certificate, backend, or custom domain is needed.

## Files

- `index.html`: the complete interface and styling.
- `gemma.js`: WebGPU detection, local model loading, and chat.
