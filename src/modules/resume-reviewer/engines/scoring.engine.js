/**
 * Calculates a weighted ATS score using a Relevance Multiplier.
 * Weights:
 * - Skill Match: 45%
 * - Experience/Projects Present & Relevant: 25%
 * - Education Present & Relevant: 10%
 * - Contact Info Complete: 10%
 * - Optimal Formatting/Length: 10%
 */
function calculateFinalScore(skillData, sections, contactInfo, rawText) {
    let totalScore = 0;
    const breakdown = {
        skills: 0,
        experience: 0,
        education: 0,
        contact: 0,
        formatting: 0
    };

    // 1. Skills (Max 45)
    breakdown.skills = Math.round((skillData.matchPercentage / 100) * 45);
    totalScore += breakdown.skills;

    // 🚨 THE CTO FIX: RELEVANCE MULTIPLIER 🚨
    // If a candidate has a 0% skill match, their experience is NOT relevant to THIS job.
    // We use the skill match percentage to weight the value of their experience.
    // We set a floor of 0.2 (20%) so they get a tiny bit of credit for general professionalism.
    const relevanceMultiplier = Math.max(0.2, (skillData.matchPercentage / 100));

    // 2. Experience/Projects (Max 25)
    const hasExp = sections.experience && sections.experience.length > 20;
    const hasProj = sections.projects && sections.projects.length > 20;
    
    let expBaseScore = 0;
    if (hasExp && hasProj) expBaseScore = 25;
    else if (hasExp || hasProj) expBaseScore = 20;

    // Apply the multiplier (e.g., 25 base score * 0% match = 5 points instead of 25)
    breakdown.experience = Math.round(expBaseScore * relevanceMultiplier);
    totalScore += breakdown.experience;

    // 3. Education (Max 10)
    let eduBaseScore = 0;
    if (sections.education && sections.education.length > 10) {
        eduBaseScore = 10;
    }
    
    // Education is a bit more universally transferable (a degree is a degree), 
    // so we give it a milder penalty floor of 0.4 (40%) if skills don't match.
    const eduMultiplier = Math.max(0.4, (skillData.matchPercentage / 100));
    breakdown.education = Math.round(eduBaseScore * eduMultiplier);
    totalScore += breakdown.education;

    // 4. Contact (Max 10) - Stays the same (always relevant)
    let contactScore = 0;
    if (contactInfo.email) contactScore += 3;
    if (contactInfo.phone) contactScore += 3;
    if (contactInfo.linkedin) contactScore += 4;
    breakdown.contact = contactScore;
    totalScore += breakdown.contact;

    // 5. Formatting/Length (Max 10) - Stays the same (always relevant)
    const wordCount = rawText.split(/\s+/).length;
    if (wordCount >= 250 && wordCount <= 1000) {
        breakdown.formatting = 10;
    } else if (wordCount > 150) {
        breakdown.formatting = 5; // Penalty for being too short/long
    }
    totalScore += breakdown.formatting;

    return {
        total: totalScore,
        breakdown
    };
}

module.exports = { calculateFinalScore };