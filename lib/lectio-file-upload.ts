const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const MAX_UPLOAD_FILENAME_LENGTH = 180;

export interface LectioUploadResult {
  serializedId: string;
  uploadedFilename: string;
  filenameWasSanitized: boolean;
}

/**
 * Lectio rejects multipart uploads whose filename contains characters such as
 * quotes or question marks. Keep the extension intact and only replace the
 * unsafe filename characters; the file contents and MIME type are untouched.
 */
export function sanitizeLectioUploadFilename(filename: string): string {
  const normalized = filename.normalize('NFC').trim();
  const lastDot = normalized.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < normalized.length - 1;
  const rawStem = hasExtension ? normalized.slice(0, lastDot) : normalized;
  const rawExtension = hasExtension ? normalized.slice(lastDot + 1) : '';
  const extension = rawExtension.replace(UNSAFE_FILENAME_CHARS, '_').replace(/[. ]+$/g, '');
  const suffix = extension ? `.${extension}` : '';
  const maxStemLength = Math.max(1, MAX_UPLOAD_FILENAME_LENGTH - suffix.length);
  const stem = rawStem
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, maxStemLength)
    .replace(/[. ]+$/g, '') || 'upload';
  return `${stem}${suffix}`;
}

export async function uploadDocumentToLectio(
  file: File,
  schoolId: string,
): Promise<LectioUploadResult> {
  const uploadUrl = new URL(
    `/lectio/${schoolId}/dokumentupload.aspx`,
    window.location.origin,
  ).href;
  const uploadedFilename = sanitizeLectioUploadFilename(file.name);
  const uploadFile = uploadedFilename === file.name
    ? file
    : new File([file], uploadedFilename, {
        type: file.type,
        lastModified: file.lastModified,
      });
  const formData = new FormData();
  formData.append('file', uploadFile);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!response.ok) throw new Error(`File upload failed with HTTP ${response.status}`);

  const body = await response.text();
  let serializedId = '';
  try {
    serializedId = JSON.parse(body)?.serializedId || '';
  } catch {
    const match = body.match(/serializedId['":\s]+['"]([^'"]+)['"]/);
    serializedId = match?.[1] || '';
  }
  if (!serializedId) throw new Error('Could not parse upload response');

  return {
    serializedId,
    uploadedFilename,
    filenameWasSanitized: uploadedFilename !== file.name,
  };
}
