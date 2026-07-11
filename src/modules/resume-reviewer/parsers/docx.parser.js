const mammoth = require('mammoth');

/**
 * Extracts text from a DOCX buffer.
 * @param {Buffer} fileBuffer - The uploaded DOCX file buffer.
 * @returns {Promise<string>} - The extracted raw text.
 */
async function parseDOCX(fileBuffer) {
    try {
        if (!fileBuffer) {
            throw new Error('No file buffer provided to DOCX parser.');
        }
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        return result.value;
    } catch (error) {
        console.error('DOCX Parsing Error:', error.message);
        throw new Error('Failed to parse DOCX document. Ensure the file is a valid Word document.');
    }
}

module.exports = { parseDOCX };