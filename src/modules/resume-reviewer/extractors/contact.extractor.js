/**
 * Extracts contact information (Email, Phone, LinkedIn, GitHub, Website) from resume text.
 * @param {string} text - The cleaned resume text.
 * @returns {Object} - Extracted contact details.
 */
function extractContactInfo(text) {
    // 1. Email Regex (Standard RFC 5322 approximation)
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    
    // 2. Phone Regex (Catches international formats, spaces, dashes, and parentheses)
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    
    // 3. LinkedIn Regex
    const linkedinRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/gi;
    
    // 4. GitHub Regex
    const githubRegex = /(?:https?:\/\/)?(?:www\.)?github\.com\/[a-zA-Z0-9_-]+\/?/gi;

    // Execute searches
    const emails = text.match(emailRegex) || [];
    const phones = text.match(phoneRegex) || [];
    const linkedins = text.match(linkedinRegex) || [];
    const githubs = text.match(githubRegex) || [];

    return {
        email: emails.length > 0 ? emails[0] : null,
        phone: phones.length > 0 ? phones[0] : null, // Grabs the first valid phone number
        linkedin: linkedins.length > 0 ? linkedins[0] : null,
        github: githubs.length > 0 ? githubs[0] : null,
        hasContactInfo: emails.length > 0 || phones.length > 0
    };
}

module.exports = { extractContactInfo };