import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';


function Background () {
	const [ansiArt, setAnsiArt] = useState<string>('');
	const [debugMessage, setDebugMessage] = useState<string>('Initializing image parser...');

	useEffect(() => {
		// 1. Resolve absolute path to double-check file existence
		const relativePath = './assets/orbit.png';
		const absolutePath = path.resolve(relativePath);
		
		setDebugMessage(`Checking path: ${absolutePath}`);

		if (!fs.existsSync(absolutePath)) {
			setDebugMessage(`❌ ERROR: File not found at target location:\n${absolutePath}`);
			return;
		}

		try {
			const fileBuffer = fs.readFileSync(absolutePath);
			const png = PNG.sync.read(fileBuffer);

			// Downscale image parameters to easily fit standard terminal sizes
			const targetWidth = 45;
			const targetHeight = Math.round((png.height / png.width) * targetWidth * 0.5);

			setDebugMessage(`Image loaded successfully! Dimensions: ${png.width}x${png.height}. Rendering output matrix...`);

			let result = '';

			for (let y = 0; y < targetHeight * 2; y += 2) {
				for (let x = 0; x < targetWidth; x++) {
					const srcX = Math.floor((x / targetWidth) * png.width);
					const srcY1 = Math.floor((y / (targetHeight * 2)) * png.height);
					const srcY2 = Math.floor(((y + 1) / (targetHeight * 2)) * png.height);

					const idx1 = (png.width * srcY1 + srcX) << 2;
					const idx2 = (png.width * srcY2 + srcX) << 2;

					let r1 = png.data[idx1] || 0, g1 = png.data[idx1 + 1] || 0, b1 = png.data[idx1 + 2] || 0;
					let r2 = png.data[idx2] || 0, g2 = png.data[idx2 + 1] || 0, b2 = png.data[idx2 + 2] || 0;

					// Set to 0.5 (50% brightness) for this isolation test so you can see it clearly
					const dimFactor = 0.5; 
					r1 = Math.round(r1 * dimFactor); g1 = Math.round(g1 * dimFactor); b1 = Math.round(b1 * dimFactor);
					r2 = Math.round(r2 * dimFactor); g2 = Math.round(g2 * dimFactor); b2 = Math.round(b2 * dimFactor);

					result += `\x1b[38;2;${r1};${g1};${b1}m\x1b[48;2;${r2};${g2};${b2}m▀`;
				}
				result += '\x1b[0m\n';
			}

			setAnsiArt(result);
		} catch (err: any) {
			setDebugMessage(`❌ ERROR parsing image file: ${err.message}`);
		}
	}, []);

	return (
		<Box flexDirection="column" padding={2} borderStyle="double" borderColor="magenta">
			<Box marginBottom={1}>
				<Text bold color="magenta">=== ORBIT CLI BACKGROUND DEBUGGER ===</Text>
			</Box>
			
			<Box marginBottom={1} borderStyle="single" borderColor="gray" paddingX={1}>
				<Text color="yellow">{debugMessage}</Text>
			</Box>

			{ansiArt ? (
				<Box borderStyle="round" borderColor="cyan" padding={1} justifyContent="center">
					<Text>{ansiArt}</Text>
				</Box>
			) : (
				<Text dimColor>Waiting for ANSI matrix build pipeline...</Text>
			)}
		</Box>
	);
}

render(<Background />);