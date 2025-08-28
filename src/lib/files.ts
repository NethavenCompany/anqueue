import fs from "fs";
import path from "path";

export async function ensureDir(directory: string) {
	try {
		return await fs.promises.mkdir(directory, { recursive: true });
	} catch (err) {
		console.error(`Failed to create directory ${directory}:`, err);
		return;
	}
}

export async function clearDir(directory: string) {
	try {
		const files = await fs.promises.readdir(directory);
		for (const file of files) {
			const filePath = path.join(directory, file);
			if ((await fs.promises.lstat(filePath)).isFile()) {
				await fs.promises.unlink(filePath);
			}
		}
	} catch (err) {
		console.error("Error clearing avatar directory:", err);
	}
}

export function getFileParts(filename: string): {
	extension: string;
	filename: string;
	nameWithoutExtension: string;
} {
	const base = path.basename(filename);
	const lastDot = base.lastIndexOf(".");
	if (lastDot === -1 || lastDot === 0) {
		return {
			extension: "",
			filename: base,
			nameWithoutExtension: base
		};
	}
	return {
		extension: base.slice(lastDot + 1),
		filename: base,
		nameWithoutExtension: base.slice(0, lastDot)
	};
}

export const changeFileExtensions = (filenames: string[], extensions: string[], only?: "with" | "without") => {
	let result: string[] = [];

	extensions.forEach((extension) => {
		// Normalize extension by removing leading dot if present
		const normalizedExtension = extension.replace(/^\./, "");

		const withExtension = filenames.flatMap((filename: string) => {
			const { extension: fileExt, nameWithoutExtension } = getFileParts(filename);
			const hasExtension = fileExt === normalizedExtension;

			if (hasExtension) {
				// If filename already has this extension, return both with and without extension
				return [nameWithoutExtension, filename];
			}

			// If filename doesn't have this extension, return both original and with extension
			return [filename, `${filename}.${normalizedExtension}`];
		});

        // If the user only wants the filenames with the extension or without the extension 
		if (only && only === "with") result = [...withExtension];
		if (only && only === "without") result = [...result];
		else result = [...result, ...withExtension];
	});

	// Remove any duplicates
	return [...new Set(result)];
};