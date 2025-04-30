    // mandelbrotWorker.js

    self.onmessage = function(e) {
        // Check if data exists and has the expected properties
        if (!e.data || typeof e.data !== 'object') {
            console.error("Worker received invalid data:", e.data);
            // Optionally post back an error message
            // self.postMessage({ error: "Invalid data received" });
            return;
        }

        const { width, height, centerX, centerY, scale, maxIterations, palette } = e.data;

        // Validate required parameters
        if (width == null || height == null || centerX == null || centerY == null || scale == null || maxIterations == null || !Array.isArray(palette)) {
             console.error("Worker received incomplete data:", e.data);
             return;
        }
         // Further validation for numeric types and positive dimensions/iterations
         if (isNaN(width) || isNaN(height) || isNaN(centerX) || isNaN(centerY) || isNaN(scale) || isNaN(maxIterations) || width <= 0 || height <= 0 || maxIterations <= 0 || scale <= 0) {
             console.error("Worker received invalid numeric data or dimensions:", e.data);
             return;
         }


        console.log(`Worker received task: ${width}x${height}, center=(${centerX.toFixed(4)},${centerY.toFixed(4)}), scale=${scale.toExponential(3)}, iter=${maxIterations}`);

        const imageDataArrayBuffer = new ArrayBuffer(width * height * 4);
        const imageDataArray = new Uint8ClampedArray(imageDataArrayBuffer);
        const aspectRatio = width / height; // Use actual canvas aspect ratio

        // Calculate bounds in the complex plane based on center, scale, and aspect ratio
        const halfScaleY = scale / 2;
        const halfScaleX = halfScaleY * aspectRatio;

        const xMin = centerX - halfScaleX;
        const yMin = centerY - halfScaleY;
        // No need for xMax, yMax, calculate dx, dy directly
        const dx = (halfScaleX * 2) / width;
        const dy = (halfScaleY * 2) / height;


        for (let py = 0; py < height; py++) {
            const cy = yMin + py * dy; // Imaginary part
            for (let px = 0; px < width; px++) {
                const cx = xMin + px * dx; // Real part
                let zx = 0.0;
                let zy = 0.0;
                let iteration = 0;
                let zx2 = 0.0; // zx * zx
                let zy2 = 0.0; // zy * zy

                // Optimization: Check if the point is inside the main cardioid or period-2 bulb
                const q = (cx - 0.25) * (cx - 0.25) + cy * cy;
                if (q * (q + (cx - 0.25)) < 0.25 * cy * cy || (cx + 1) * (cx + 1) + cy * cy < 1/16) {
                    iteration = maxIterations; // Belongs to the set, skip iteration
                } else {
                    // Iterate
                    while (zx2 + zy2 <= 4 && iteration < maxIterations) {
                        zy = 2 * zx * zy + cy;
                        zx = zx2 - zy2 + cx;
                        zx2 = zx * zx;
                        zy2 = zy * zy;
                        iteration++;
                    }
                }


                // Determine color
                const colorIndex = iteration < maxIterations ? iteration % palette.length : palette.length -1 ; // Use modulo for palette cycling, last color for inside
                const color = palette[colorIndex] || [0, 0, 0]; // Fallback color

                const pixelIndex = (py * width + px) * 4;
                imageDataArray[pixelIndex] = color[0];     // R
                imageDataArray[pixelIndex + 1] = color[1]; // G
                imageDataArray[pixelIndex + 2] = color[2]; // B
                imageDataArray[pixelIndex + 3] = 255;      // A
            }
        }

        console.log("Worker finished calculation.");
        // Send the result back to the main thread using the ArrayBuffer
        self.postMessage({ imageDataArray: imageDataArrayBuffer }, [imageDataArrayBuffer]);
    };

    // Optional: Handle potential errors during worker initialization or script loading
    self.onerror = function(event) {
        console.error("Error in worker script:", event.message, event.filename, event.lineno);
        // Prevent default error handling if needed
        // event.preventDefault();
    };


    console.log("Mandelbrot worker loaded and ready.");
