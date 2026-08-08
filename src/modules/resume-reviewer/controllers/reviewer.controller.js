const { extractAndCleanText } = require('../services/parser.service');
const { extractSections } = require('../extractors/section.extractor');
const { extractContactInfo } = require('../extractors/contact.extractor');
const skillExtractor = require('../extractors/skill.extractor');
const { calculateSkillMatch } = require('../engines/matching.engine');
const { evaluateRules } = require('../engines/rule.engine');
const { calculateFinalScore } = require('../engines/scoring.engine');

// Assuming you have an expertRecommender service that queries your MySQL DB
const expertRecommender = require('../services/expert.recommender'); 

exports.analyzeResume = async (req, res, next) => {
    try {
        // 🚨 ADD THIS SAFETY CHECK FIRST!
        if (!req.files || !req.files.resume || !req.files.resume[0]) {
            console.error("Multer did not find the 'resume' file in the request.");
            return res.status(400).json({ 
                success: false, 
                error: 'Resume file missing. Please check your upload.' 
            });
        }

        const resumeBuffer = req.files.resume[0].buffer;
        const mimetype = req.files.resume[0].mimetype;
        const jdText = req.body.job_description;

        if (!resumeBuffer || !jdText) {
            return res.status(400).json({ success: false, error: 'Resume file and Job Description text are required.' });
        }

        // --- PIPELINE START --- //

        // 1. Ingestion & Sanitization
        const cleanResume = await extractAndCleanText(resumeBuffer, mimetype);
        const cleanJD = jdText.toLowerCase();

        // 2. Extraction
        const contactInfo = extractContactInfo(cleanResume);
        const sections = extractSections(cleanResume);
        
        const resumeSkills = Array.from(skillExtractor.extractSkills(cleanResume));
        const jdSkills = Array.from(skillExtractor.extractSkills(cleanJD));

        // 🚨 ADD THIS NEW CHECK HERE:
        if (jdSkills.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: "I couldn't detect any technical skills in that Job Description. Please paste a more detailed job posting!" 
            });
        }

        // 3. Engines
        const skillMatchData = calculateSkillMatch(resumeSkills, jdSkills);
        const ruleFeedback = evaluateRules(cleanResume, contactInfo, sections, skillMatchData.missing);
        const scoringData = calculateFinalScore(skillMatchData, sections, contactInfo, cleanResume);

        // 4. Expert Recommendations (YB Connect Specific)
        // Find experts on your platform who have the skills the user is missing
        const recommendedExperts = await expertRecommender.findExpertsBySkills(skillMatchData.missing);

        // --- PIPELINE END --- //

        // Return the structured JSON
        return res.status(200).json({
            success: true,
            data: {
                score: scoringData,
                skills: skillMatchData,
                feedback: ruleFeedback,
                extractedMetadata: {
                    contact: contactInfo,
                    hasExperienceSection: !!sections.experience,
                    hasEducationSection: !!sections.education
                },
                recommendedExperts
            }
        });

    } catch (error) {
        console.error('Resume Reviewer Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
};