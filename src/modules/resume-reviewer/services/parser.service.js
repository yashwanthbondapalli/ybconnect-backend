const { parsePDF } = require('../parsers/pdf.parser.js');
const { parseDOCX } = require('../parsers/docx.parser.js');
const { sanitizeText } = require('../parsers/text.cleaner.js');

/**
 * Master function to process any supported resume file into clean ATS text.
 * @param {Buffer} fileBuffer - The file data in memory.
 * @param {string} mimetype - The MIME type of the uploaded file.
 * @returns {Promise<string>} - Clean, ready-to-process text.
 */
async function extractAndCleanText(fileBuffer, mimetype) {
    let rawText = '';

    if (mimetype === 'application/pdf') {
        rawText = await parsePDF(fileBuffer);
    } 
    else if (
        mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
        mimetype === 'application/msword'
    ) {
        rawText = await parseDOCX(fileBuffer);
    } 
    else if (mimetype === 'text/plain') {
        rawText = fileBuffer.toString('utf-8');
    }
    else {
        throw new Error('Unsupported file format. Please upload a PDF, DOCX, or TXT file.');
    }

    // Pass the raw text through the sanitizer before returning
    return sanitizeText(rawText);
}

module.exports = { extractAndCleanText };