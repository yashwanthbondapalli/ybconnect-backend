/**
 * Evaluates the resume against standard ATS and HR rules to generate feedback.
 * @param {Object} rawText - The full cleaned text (for length checking).
 * @param {Object} contactInfo - Extracted contact object.
 * @param {Object} sections - Sliced resume sections.
 * @param {string[]} missingSkills - Array of skills missing from the resume.
 * @returns {Object} - Strengths, weaknesses, and actionable suggestions.
 */
function evaluateRules(rawText, contactInfo, sections, missingSkills) {
    const strengths = [];
    const weaknesses = [];
    const suggestions = [];

    // Rule 1: Contact Information Completeness
    if (contactInfo.email && contactInfo.phone) {
        strengths.push("Essential contact information (Email & Phone) is present.");
    } else {
        weaknesses.push("Missing essential contact information.");
        suggestions.push("Add both a professional email and a phone number so recruiters can easily reach you.");
    }

    if (contactInfo.linkedin) {
    } else {
        suggestions.push("Include a link to your LinkedIn profile. and github profile, leetcode 87% of recruiters check LinkedIn during the hiring process.");
    }

    // Rule 2: Resume Length (Word Count Heuristic)
    const wordCount = rawText.split(/\s+/).length;
    if (wordCount < 250) {
        weaknesses.push("Resume is too short.");
        suggestions.push("Your resume lacks detail. Expand on your experiences using quantifiable metrics (e.g., 'Improved performance by 20%').");
    } else if (wordCount > 1000) {
        weaknesses.push("Resume is too long.");
        suggestions.push("Your resume is over 1,000 words. Try to condense it to 1-2 pages to ensure ATS parsers and recruiters read the most important details.");
    } else {
        strengths.push("Optimal resume length.");
    }

    // Rule 3: Missing Sections
    if (!sections.education || sections.education.length < 10) {
        weaknesses.push("Missing or poorly formatted Education section.");
        suggestions.push("Add an 'Education' section. Include your degree, university name, and graduation year.");
    }

        if (!sections.projects) {
        weaknesses.push("Missing Projects.");
        suggestions.push("You must include Projects section to demonstrate your practical skills.");
    }
    
    if (!sections.projects && !sections.experience) {
        weaknesses.push("Missing Experience and Projects.");
        suggestions.push("You must include either a 'Work Experience' or 'Projects' section to demonstrate your practical skills.");
    } else {
        strengths.push("Practical experience sections detected.");
    }



// Rule 4: Critical Missing Skills
    if (missingSkills.length > 0) {
        // 🚨 THE FIX: Remove the .slice(0, 3) so it lists EVERY missing skill!
        const allMissing = missingSkills.join(", "); 
        weaknesses.push(`Missing critical job skills: ${allMissing}.`);
        suggestions.push(`Update your resume to explicitly mention these missing skills. If you lack them, consider taking a crash course.`);
    }

    return { strengths, weaknesses, suggestions };
}

module.exports = { evaluateRules };