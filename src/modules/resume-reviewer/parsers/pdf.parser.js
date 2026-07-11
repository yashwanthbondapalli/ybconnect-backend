const pdfExtract = require('pdf-extraction');

/**
 * Extracts text from a PDF buffer with built-in retry logic.
 * @param {Buffer} fileBuffer - The uploaded PDF file buffer.
 * @param {number} retries - How many times to try before giving up.
 * @returns {Promise<string>} - The extracted raw text.
 */
async function parsePDF(fileBuffer, retries = 2) {
    if (!fileBuffer) {
        throw new Error('No file buffer provided to PDF parser.');
    }

    for (let i = 0; i <= retries; i++) {
        try {
            // Attempt to parse the PDF
            const data = await pdfExtract(fileBuffer);
            return data.text;
            
        } catch (error) {
            // If it fails on the last try, throw the actual error
            if (i === retries) {
                console.error('PDF Parsing Error (Final Attempt):', error.message);
                throw new Error('Failed to parse PDF document. Ensure the file is not corrupted or password-protected.');
            }
            
            // Otherwise, it was a memory hiccup. Wait 500ms and try again!
            console.log(`[PDF Parser] Hiccup detected. Retrying... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

module.exports = { parsePDF };