export async function preparePhoto(
  file: File,
  options: { maxPixels?: number; maxBytes?: number } = {},
): Promise<Blob> {
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Choose a photo smaller than 20 MB.");
  if (
    !file.type.startsWith("image/") ||
    ["image/svg+xml", "image/gif"].includes(file.type)
  )
    throw new Error("Choose a still photo such as JPEG, PNG, or WebP.");
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "This photo format could not be opened. Try a JPEG or PNG copy.",
    );
  }
  const scale = Math.min(
    1,
    (options.maxPixels || 1600) / Math.max(image.width, image.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    image.close();
    throw new Error("This browser cannot prepare the photo.");
  }
  ctx.fillStyle = "#fffefd";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const encode = (quality: number) =>
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Could not prepare this photo.")),
        "image/jpeg",
        quality,
      ),
    );
  for (const quality of [0.85, 0.7, 0.5, 0.35, 0.2, 0.12, 0.08]) {
    const blob = await encode(quality);
    if (blob.size <= (options.maxBytes || 1048576)) return blob;
  }
  throw new Error(
    "This photo is still too large after resizing. Try a smaller copy.",
  );
}
