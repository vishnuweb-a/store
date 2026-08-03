const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

/**
 * Uploads a file straight to Cloudinary with an unsigned preset, so no API
 * secret is ever exposed to the browser.
 *
 * @param {File} file
 * @returns {Promise<{image_url: string, cloudinary_public_id: string}>}
 */
export async function uploadImage(file) {
  if (!cloudName || !uploadPreset) {
    throw new Error('Cloudinary is not configured. Set VITE_CLOUDINARY_* in .env.');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', uploadPreset);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error('Image upload failed. Please try again.');
  }

  const data = await response.json();
  return { image_url: data.secure_url, cloudinary_public_id: data.public_id };
}
