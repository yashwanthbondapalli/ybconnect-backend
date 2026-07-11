/**
 * Sanitizes raw text extracted from documents for uniform ATS processing.
 * @param {string} rawText - The raw text from PDF/DOCX.
 * @returns {string} - The cleaned, normalized text.
 */
function sanitizeText(rawText) {
    if (!rawText) return '';

    return rawText
        // 1. Convert to lowercase for case-insensitive matching later
        .toLowerCase()
        // 2. Replace weird bullet points and special characters with standard spaces
        .replace(/[•▪►❖➢➔✓]/g, ' ')
        // 3. Remove zero-width characters and non-printable unicode junk
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // 4. Standardize all line breaks to a single newline character (\n)
        .replace(/\r\n|\r/g, '\n')
        // 5. Replace multiple consecutive newlines with a double newline (preserves paragraph structure)
        .replace(/\n{3,}/g, '\n\n')
        // 6. Replace multiple spaces/tabs with a single space
        .replace(/[ \t]{2,}/g, ' ')
        // 7. Trim leading and trailing whitespace
        .trim();
}

module.exports = { sanitizeText };