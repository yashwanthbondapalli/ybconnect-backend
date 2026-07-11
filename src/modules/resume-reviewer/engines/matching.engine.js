/**
 * Compares Resume Skills against Job Description (JD) Skills.
 * @param {string[]} resumeSkills - Array of canonical skills found in the resume.
 * @param {string[]} jdSkills - Array of canonical skills required by the JD.
 * @returns {Object} - Match analytics.
 */
function calculateSkillMatch(resumeSkills, jdSkills) {
    const resumeSet = new Set(resumeSkills);
    const jdSet = new Set(jdSkills);

    const matched = [];
    const missing = [];
    const extra = [];

    // Find Matched and Missing skills based on the JD
    jdSet.forEach(skill => {
        if (resumeSet.has(skill)) {
            matched.push(skill);
        } else {
            missing.push(skill);
        }
    });

    // Find Extra skills the candidate has that aren't strictly in the JD
    resumeSet.forEach(skill => {
        if (!jdSet.has(skill)) {
            extra.push(skill);
        }
    });

    // Calculate Match Percentage (Avoid division by zero)
    let matchPercentage = 0;
    if (jdSet.size > 0) {
        matchPercentage = Math.round((matched.length / jdSet.size) * 100);
    } else if (resumeSet.size > 0) {
        // If the JD had no recognizable skills, but the resume did, give them a baseline score
        matchPercentage = 100; 
    }

    return {
        matched,
        missing,
        extra,
        matchPercentage,
        totalRequired: jdSet.size
    };
}

module.exports = { calculateSkillMatch };