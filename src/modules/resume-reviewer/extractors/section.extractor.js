/**
 * Maps common resume section titles to standard ATS buckets.
 */
const SECTION_MAPPINGS = {
    'experience': ['experience', 'work experience', 'employment history', 'professional experience', 'work history', 'internships'],
    'education': ['education', 'academic background', 'academic history', 'qualifications', 'academics'],
    'skills': ['skills', 'technical skills', 'core competencies', 'technologies', 'expertise', 'it skills'],
    'projects': [
        'projects', 
        'academic projects', 
        'personal projects', 
        'open source', 
        'core projects',        // 👈 Added!
        'technical projects',   // 👈 Added!
        'key projects',         // 👈 Added!
        'major projects'        // 👈 Added!
    ],
    'certifications': ['certifications', 'licenses', 'courses', 'training', 'achievements']
};

/**
 * Splits raw resume text into logical buckets.
 * @param {string} cleanText - The sanitized resume text.
 * @returns {Object} - An object with keys mapping to extracted text sections.
 */
function extractSections(cleanText) {
    const lines = cleanText.split('\n');
    let currentSection = 'summary'; // Default bucket for the top of the resume
    
    const sections = {
        summary: [],
        experience: [],
        education: [],
        skills: [],
        projects: [],
        certifications: [],
        uncategorized: []
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Check if the current line is a section header.
        // Heuristic: Headers are usually short (under 4 words).
        let isHeader = false;
        if (line.split(' ').length <= 4) {
            const normalizedLine = line.toLowerCase();
            
            for (const [standardSection, aliases] of Object.entries(SECTION_MAPPINGS)) {
                if (aliases.includes(normalizedLine)) {
                    currentSection = standardSection;
                    isHeader = true;
                    break;
                }
            }
        }

        // If it's not a header, push the text into the currently active bucket
        if (!isHeader) {
            sections[currentSection].push(line);
        }
    }

    // Convert arrays back to strings for downstream processing
    return {
        summary: sections.summary.join('\n'),
        experience: sections.experience.join('\n'),
        education: sections.education.join('\n'),
        skills: sections.skills.join('\n'),
        projects: sections.projects.join('\n'),
        certifications: sections.certifications.join('\n')
    };
}

module.exports = { extractSections };