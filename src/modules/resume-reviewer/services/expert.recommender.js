// Import your existing Profile model
const Profile = require('../../../models/Profile'); 

/**
 * Queries MongoDB to find top YB Connect experts who possess the skills the user is missing.
 * @param {string[]} missingSkills - Array of canonical skills missing from the resume.
 * @returns {Promise<Array>} - Array of top 5 recommended experts.
 */
async function findExpertsBySkills(missingSkills) {
    // If they aren't missing any skills, no need to recommend anyone!
    if (!missingSkills || missingSkills.length === 0) return [];

    try {
        // Query MongoDB for experts who have ANY of the missing skills
        const experts = await Profile.find({
            skills: { $in: missingSkills }, 

           // 'zoomCredentials.isConnected': true   
        })
        .populate('user', 'name') 
        .select('user designation companyName hourlyRate profileImage skills')
        .limit(5) 
        .lean(); 

        // Format the output specifically for your React Native ExpertCard component
        return experts.map(expert => {
            // Find exactly which of the missing skills this expert can teach them
            const overlappingSkills = expert.skills.filter(s => missingSkills.includes(s));

            return {
                _id: expert._id,
                name: expert.user?.name || 'YB Expert',
                designation: expert.designation,
                companyName: expert.companyName,
                hourlyRate: expert.hourlyRate,
                profileImage: expert.profileImage,
                canTeachYou: overlappingSkills
            };
        });

    } catch (error) {
        console.error('Expert Recommender MongoDB Error:', error);
       
        return []; 
    }
}

module.exports = { findExpertsBySkills };