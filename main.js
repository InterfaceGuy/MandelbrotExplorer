    const canvas = document.getElementById('mandelbrotCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const iterationsInput = document.getElementById('iterations');
    const resetButton = document.getElementById('reset');
    const loadingIndicator = document.getElementById('loading');
    const zoomSlider = document.getElementById('zoomSlider');
    const zoomInput = document.getElementById('zoomInput');

    let worker = null;
    let isRendering = false;
    let renderTimeout;

    // --- Dragging State ---
    let isDragging = false;
    let lastX, lastY; // Last mouse position during drag
    let dragStartX, dragStartY; // Mouse position where drag started
    let offscreenCanvas = null; // Canvas to hold snapshot during drag
    let offscreenCtx = null;

    // --- Constants for Zoom ---
    const INITIAL_SCALE = 2.5;
    const MIN_ZOOM_LEVEL = 0;
    const MAX_ZOOM_LEVEL = 25; // Base max for slider, can be exceeded by scroll
    const BASE_ZOOM_FACTOR = 1.5;

    // --- View State ---
    let view = {
        centerX: -0.7,
        centerY: 0,
        scale: INITIAL_SCALE,
        maxIterations: parseInt(iterationsInput.value, 10)
    };

    // --- Helper Functions ---

    function scaleToZoomLevel(scale) {
        if (scale <= 0) return MAX_ZOOM_LEVEL;
        const level = Math.log(INITIAL_SCALE / scale) / Math.log(BASE_ZOOM_FACTOR);
        // Allow calculated level to exceed MAX_ZOOM_LEVEL for display
        return Math.max(MIN_ZOOM_LEVEL, level);
    }

    function zoomLevelToScale(level) {
        return INITIAL_SCALE / Math.pow(BASE_ZOOM_FACTOR, level);
    }

    function updateZoomControls() {
        const currentZoomLevel = scaleToZoomLevel(view.scale);
        const displayLevel = parseFloat(currentZoomLevel.toFixed(2));

        // Dynamically adjust max of controls if needed
        const currentMax = Math.max(MAX_ZOOM_LEVEL, Math.ceil(displayLevel));
        if (currentMax > parseFloat(zoomSlider.max)) {
             zoomSlider.max = currentMax;
             zoomInput.max = currentMax;
        }
         // Ensure slider doesn't exceed its *current* max, even if logical zoom is higher
         zoomSlider.value = Math.min(displayLevel, parseFloat(zoomSlider.max));
         zoomInput.value = displayLevel; // Input can show the precise higher value
    }

    function resizeCanvas() {
        const aspectRatio = 1;
        const availableWidth = window.innerWidth - 20;
        const availableHeight = window.innerHeight - 80;
        let width = Math.min(availableWidth, availableHeight * aspectRatio);
        let height = width / aspectRatio;

        if (width !== canvas.width || height !== canvas.height) {
            canvas.width = Math.floor(width);
            canvas.height = Math.floor(height);
            offscreenCanvas = null; // Invalidate offscreen canvas on resize
            console.log(`Canvas resized to ${canvas.width}x${canvas.height}`);
            requestRender();
        }
    }

    // Linear interpolation function
    function lerp(start, end, t) {
        return start + t * (end - start);
    }

    // Function to convert hex color string to [r, g, b] array
    function hexToRgb(hex) {
        const bigint = parseInt(hex.slice(1), 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return [r, g, b];
    }

    function getPalette(maxIterations) {
        const colors = [];
        const colorBlue = hexToRgb("#00A2FF"); // [0, 162, 255]
        const colorWhite = hexToRgb("#FFFFFF"); // [255, 255, 255]
        const colorRed = hexToRgb("#FF644E");   // [255, 100, 78]
        const colorBlack = [0, 0, 0]; // For inside the set

        // Define the iteration range for the sharp white band
        // These ratios determine how wide the white band is relative to maxIterations
        const whiteStartRatio = 0.49; // Start white transition just before 50%
        const whiteEndRatio = 0.51;   // End white transition just after 50%

        const whiteStartIndex = Math.floor(maxIterations * whiteStartRatio);
        const whiteEndIndex = Math.floor(maxIterations * whiteEndRatio);

        // Ensure indices are within valid bounds and make sense
        const actualWhiteStartIndex = Math.max(0, Math.min(maxIterations - 1, whiteStartIndex));
        const actualWhiteEndIndex = Math.max(actualWhiteStartIndex, Math.min(maxIterations - 1, whiteEndIndex)); // Ensure end is >= start

        for (let i = 0; i < maxIterations; i++) {
            let r, g, b;

            if (i < actualWhiteStartIndex) {
                // Interpolate Blue to White
                // t goes from 0 to 1 as i goes from 0 to actualWhiteStartIndex - 1
                const t = actualWhiteStartIndex > 0 ? i / actualWhiteStartIndex : 1; // Avoid division by zero if start index is 0
                r = Math.floor(lerp(colorBlue[0], colorWhite[0], t));
                g = Math.floor(lerp(colorBlue[1], colorWhite[1], t));
                b = Math.floor(lerp(colorBlue[2], colorWhite[2], t));
            } else if (i >= actualWhiteStartIndex && i < actualWhiteEndIndex) {
                // Use solid White for the defined band
                 [r, g, b] = colorWhite;
            } else { // i >= actualWhiteEndIndex
                // Interpolate White to Red
                // t goes from 0 to 1 as i goes from actualWhiteEndIndex to maxIterations - 1
                const range = maxIterations - 1 - actualWhiteEndIndex;
                const t = range > 0 ? (i - actualWhiteEndIndex) / range : 0; // Avoid division by zero if range is 0
                r = Math.floor(lerp(colorWhite[0], colorRed[0], t));
                g = Math.floor(lerp(colorWhite[1], colorRed[1], t));
                b = Math.floor(lerp(colorWhite[2], colorRed[2], t));
            }
            colors.push([r, g, b]);
        }

        // Add the color for points inside the set (maxIterations reached)
        colors.push(colorBlack);
        return colors;
    }


    function renderMandelbrot(imageDataArray) {
        if (!imageDataArray) return;
        try {
            const imageData = new ImageData(new Uint8ClampedArray(imageDataArray), canvas.width, canvas.height);
            ctx.putImageData(imageData, 0, 0);
        } catch (error) {
             console.error("Error creating or putting ImageData:", error);
             loadingIndicator.textContent = 'Render Error!';
             loadingIndicator.style.backgroundColor = 'orange';
        } finally {
            loadingIndicator.style.display = 'none';
            isRendering = false;
            console.log("Render complete or failed.");
        }
    }

    function requestRender() {
        if (isDragging) {
            console.log("Render request skipped: Currently dragging.");
            return;
        }

        if (isRendering && worker) {
            console.log("Render request skipped: Already rendering. Terminating previous worker task.");
             worker.terminate();
             worker = null;
             isRendering = false;
        }
        isRendering = true;
        loadingIndicator.style.display = 'block';
        loadingIndicator.textContent = 'Calculating...';
        loadingIndicator.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
        console.log("Requesting render with view:", view);

        if (!worker) {
            worker = new Worker(new URL('./mandelbrotWorker.js', import.meta.url), { type: 'module' });
            worker.onmessage = (e) => {
                if (e.data && e.data.imageDataArray) {
                    renderMandelbrot(e.data.imageDataArray);
                } else {
                    console.warn("Worker returned empty or invalid data");
                    renderMandelbrot(null);
                }
            };
            worker.onerror = (e) => {
                console.error("Worker error:", e.message, e);
                loadingIndicator.textContent = 'Worker Error!';
                loadingIndicator.style.backgroundColor = 'red';
                isRendering = false;
                worker = null;
            };
             worker.onmessageerror = (e) => {
                 console.error("Worker message error:", e);
                 loadingIndicator.textContent = 'Data Error!';
                 loadingIndicator.style.backgroundColor = 'orange';
                 isRendering = false;
             };
        }

        const palette = getPalette(view.maxIterations);
        const messageData = {
            width: canvas.width,
            height: canvas.height,
            centerX: view.centerX,
            centerY: view.centerY,
            scale: view.scale,
            maxIterations: view.maxIterations,
            palette: palette
        };

        for (const key in messageData) {
            if (typeof messageData[key] === 'number' && isNaN(messageData[key])) {
                console.error(`Invalid data detected before sending to worker: ${key} is NaN`);
                loadingIndicator.textContent = 'Input Error!';
                loadingIndicator.style.backgroundColor = 'red';
                isRendering = false;
                return;
            }
        }
         if (canvas.width <= 0 || canvas.height <= 0) {
             console.error(`Invalid canvas dimensions: ${canvas.width}x${canvas.height}`);
             loadingIndicator.textContent = 'Canvas Error!';
             isRendering = false;
             return;
         }

        worker.postMessage(messageData);
    }

    function debounceRequestRender(delay = 300) {
        clearTimeout(renderTimeout);
        renderTimeout = setTimeout(requestRender, delay);
    }

    // --- Event Listeners ---

    iterationsInput.addEventListener('change', () => {
        // Parse the value, ensuring it's at least the minimum (10)
        const newIterations = Math.max(10, parseInt(iterationsInput.value, 10));
        if (!isNaN(newIterations)) {
            // Update the input field in case it was below minimum or invalid
            iterationsInput.value = newIterations;
            view.maxIterations = newIterations;
            debounceRequestRender(100);
        } else {
            // Reset to current view value if input is not a valid number
            iterationsInput.value = view.maxIterations;
        }
    });

    resetButton.addEventListener('click', () => {
        view.centerX = -0.7;
        view.centerY = 0;
        view.scale = INITIAL_SCALE;
        view.maxIterations = 100;
        iterationsInput.value = 100;
        updateZoomControls();
        requestRender();
    });

    zoomSlider.addEventListener('input', () => {
        const oldScale = view.scale; // Capture scale before update
        const level = parseFloat(zoomSlider.value);
        zoomInput.value = level.toFixed(2);
        view.scale = zoomLevelToScale(level);

        // Visual update during slide, centered on canvas
        requestAnimationFrame(() => {
            // Ensure offscreen canvas exists and is the correct size
            if (!offscreenCanvas || offscreenCanvas.width !== canvas.width || offscreenCanvas.height !== canvas.height) {
                 offscreenCanvas = new OffscreenCanvas(canvas.width, canvas.height);
            }
            const offscreenCtxTemp = offscreenCanvas.getContext('2d');

            // 1. Draw current canvas content to offscreen canvas
            offscreenCtxTemp.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
            offscreenCtxTemp.drawImage(canvas, 0, 0);

            // 2. Clear main canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // 3. Apply transformations to main canvas context
            const invScaleFactor = oldScale / view.scale;
            const cx = canvas.width / 2; // Center transformation on canvas center
            const cy = canvas.height / 2;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(invScaleFactor, invScaleFactor);
            ctx.translate(-cx, -cy);

            // 4. Draw from offscreen canvas onto the transformed main canvas
            ctx.drawImage(offscreenCanvas, 0, 0);

            // 5. Restore main canvas context
            ctx.restore();
        });

        updateZoomControls();
        debounceRequestRender(50); // Render smoothly while sliding
    });

    zoomSlider.addEventListener('change', () => {
        const level = parseFloat(zoomSlider.value);
        view.scale = zoomLevelToScale(level);
        updateZoomControls();
        requestRender(); // Final render on release
    });

    zoomInput.addEventListener('change', () => {
        let level = parseFloat(zoomInput.value);
        if (isNaN(level)) {
            level = scaleToZoomLevel(view.scale); // Reset if invalid
        }
        // Clamp input level only by minimum, allow exceeding MAX_ZOOM_LEVEL
        level = Math.max(MIN_ZOOM_LEVEL, level);
        zoomInput.value = level.toFixed(2);

        // Update slider, but clamp its value to its current maximum
        const sliderMax = parseFloat(zoomSlider.max);
        zoomSlider.value = Math.min(level, sliderMax);

        view.scale = zoomLevelToScale(level);
        updateZoomControls(); // Update max attributes if needed
        // No immediate visual update needed for number input change, just trigger render
        requestRender();
    });

    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const oldScale = view.scale; // Capture scale before update

        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        const complexX = view.centerX + (mouseX / canvas.width - 0.5) * view.scale * (canvas.width / canvas.height);
        const complexY = view.centerY + (mouseY / canvas.height - 0.5) * view.scale;

        const zoomFactor = event.deltaY < 0 ? 0.8 : 1.25;
        view.scale *= zoomFactor;

        // No need to clamp scale here, let zoom level handle limits
        // const minScale = zoomLevelToScale(MAX_ZOOM_LEVEL); // Theoretical max
        // const maxScale = zoomLevelToScale(MIN_ZOOM_LEVEL);
        // view.scale = Math.max(minScale, Math.min(maxScale, view.scale));

        view.centerX = complexX - (mouseX / canvas.width - 0.5) * view.scale * (canvas.width / canvas.height);
        view.centerY = complexY - (mouseY / canvas.height - 0.5) * view.scale;

        // Visual update during wheel, centered on mouse position
        requestAnimationFrame(() => {
            // Ensure offscreen canvas exists and is the correct size
            if (!offscreenCanvas || offscreenCanvas.width !== canvas.width || offscreenCanvas.height !== canvas.height) {
                 offscreenCanvas = new OffscreenCanvas(canvas.width, canvas.height);
            }
            const offscreenCtxTemp = offscreenCanvas.getContext('2d');

            // 1. Draw current canvas content to offscreen canvas
            offscreenCtxTemp.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
            offscreenCtxTemp.drawImage(canvas, 0, 0);

            // 2. Clear main canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // 3. Apply transformations to main canvas context
            const invScaleFactor = oldScale / view.scale;
            const cx = mouseX; // Center the transformation on the mouse
            const cy = mouseY;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(invScaleFactor, invScaleFactor);
            ctx.translate(-cx, -cy);

            // 4. Draw from offscreen canvas onto the transformed main canvas
            ctx.drawImage(offscreenCanvas, 0, 0);

            // 5. Restore main canvas context
            ctx.restore();
        });


        updateZoomControls();
        debounceRequestRender();
    });

    // --- Panning Logic ---
    canvas.addEventListener('mousedown', (event) => {
        if (isRendering) return;
        isDragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        dragStartX = lastX;
        dragStartY = lastY;
        canvas.style.cursor = 'grabbing';

        if (!offscreenCanvas || offscreenCanvas.width !== canvas.width || offscreenCanvas.height !== canvas.height) {
            offscreenCanvas = new OffscreenCanvas(canvas.width, canvas.height);
        }
        const offscreenCtxTemp = offscreenCanvas.getContext('2d');
        offscreenCtxTemp.clearRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);
        offscreenCtxTemp.drawImage(canvas, 0, 0);

        console.log("Drag started, canvas snapshot taken.");
    });

    canvas.addEventListener('mousemove', (event) => {
        if (!isDragging) return;

        const currentX = event.clientX;
        const currentY = event.clientY;
        const incrementalDx = currentX - lastX;
        const incrementalDy = currentY - lastY;
        const moveScale = view.scale / canvas.width;
        view.centerX -= incrementalDx * moveScale;
        view.centerY -= incrementalDy * moveScale * (canvas.height / canvas.width);

        const totalDx = currentX - dragStartX;
        const totalDy = currentY - dragStartY;

        requestAnimationFrame(() => {
            if (!isDragging) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (offscreenCanvas) {
                ctx.drawImage(offscreenCanvas, totalDx, totalDy);
            }
        });

        lastX = currentX;
        lastY = currentY;
    });

    function handleDragEnd() {
        if (isDragging) {
            isDragging = false;
            canvas.style.cursor = 'grab';
            console.log("Drag ended. Requesting final render.");
            requestRender();
        }
    }

    canvas.addEventListener('mouseup', handleDragEnd);
    canvas.addEventListener('mouseleave', handleDragEnd);

    // Initial setup
    window.addEventListener('resize', () => {
        clearTimeout(renderTimeout);
        debounceRequestRender(500);
    });
    zoomSlider.min = MIN_ZOOM_LEVEL;
    zoomSlider.max = MAX_ZOOM_LEVEL; // Initial max
    zoomInput.min = MIN_ZOOM_LEVEL;
    zoomInput.max = MAX_ZOOM_LEVEL; // Initial max, will be updated dynamically
    updateZoomControls();
    resizeCanvas(); // Initial size and render
