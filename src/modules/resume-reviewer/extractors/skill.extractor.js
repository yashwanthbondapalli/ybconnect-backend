const AhoCorasick = require('ahocorasick');
const skillsDictionary = require('../data/skills.dictionary.json');

class SkillExtractor {
    constructor() {
        this.trie = null;
        this.aliasToCanonicalMap = new Map();
        this.buildTrie();
    }

    /**
     * Builds the search tree in server memory when the app boots.
     */
    buildTrie() {
        const keywords = [];

        skillsDictionary.forEach(skill => {
            skill.aliases.forEach(alias => {
                const lowerAlias = alias.toLowerCase();
                keywords.push(lowerAlias);
                // Map the alias back to the exact Canonical Name (e.g., "js" -> "JavaScript")
                // 🚨 THE CTO FIX: Catch both camelCase and snake_case!
                const exactName = skill.canonicalName || skill.canonical_name;
                this.aliasToCanonicalMap.set(lowerAlias, exactName);
            });
        });

        // Initialize the Aho-Corasick automaton with all aliases
        this.trie = new AhoCorasick(keywords);
        console.log(`[SkillExtractor] Trie built successfully with ${keywords.length} keywords.`);
    }

    /**
     * Sweeps the text and extracts skills.
     * @param {string} cleanText - The sanitized text from the resume or JD.
     * @returns {Set<string>} - A unique set of canonical skill names.
     */
    extractSkills(cleanText) {
        if (!cleanText) return new Set();

        const results = this.trie.search(cleanText.toLowerCase());
        const extractedSkills = new Set();

        results.forEach(match => {
            const matchedAliases = match[1]; 
            
            matchedAliases.forEach(alias => {
                const endIndex = match[0];
                const startIndex = endIndex - alias.length + 1;
                
                const charBefore = startIndex > 0 ? cleanText[startIndex - 1] : ' ';
                const charAfter = endIndex < cleanText.length - 1 ? cleanText[endIndex + 1] : ' ';

                // 🚨 THE CTO FIX: The Ultimate Word Boundary Check
                // Instead of guessing punctuation, we just check: "Is it NOT a letter or number?"
                const isWordBoundaryBefore = !/[a-zA-Z0-9]/.test(charBefore);
                const isWordBoundaryAfter = !/[a-zA-Z0-9]/.test(charAfter);

                if (isWordBoundaryBefore && isWordBoundaryAfter) {
                    const canonicalName = this.aliasToCanonicalMap.get(alias);
                    extractedSkills.add(canonicalName);
                }
            });
        });

        return extractedSkills;
    }
}

// Export as a Singleton so the Trie is only built once per Node.js process
const skillExtractorInstance = new SkillExtractor();
module.exports = skillExtractorInstance;