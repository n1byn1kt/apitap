// src/doctor/checks/junk-domain.ts
import { isBlocklisted } from '../../capture/blocklist.js';
import { isBeaconShaped } from './beacon-endpoints.js';
import type { SkillFile } from '../../types.js';
import type { Check, Finding, FixPlan } from '../types.js';

/**
 * Pattern extensions beyond the exact capture blocklist — grown from what the
 * store actually accumulated (dogfood 2026-07-19). isBlocklisted() covers the
 * curated exact/parent-domain list; these catch structural junk families.
 */
const JUNK_DOMAIN_PATTERNS: RegExp[] = [
  /(^|\.)awswaf\.com$/i,       // AWS WAF captcha/token/challenge hosts
  /(^|\.)captcha\./i,          // captcha subdomains anywhere
  /adsystem/i,                 // aax.amazon-adsystem.com and friends
  /(^|\.)adsrvr\.org$/i,
  /(^|\.)onetrust\.com$/i,     // consent/CMP SDKs
  /(^|\.)cookielaw\.org$/i,
];

export const junkDomain: Check = {
  id: 'junk-domain',
  title: 'Junk domains (ads/tracking/WAF/consent)',
  scan(skill: SkillFile): Finding[] {
    const base = { checkId: 'junk-domain', domain: skill.domain };
    if (isBlocklisted(skill.domain)) {
      return [{ ...base, severity: 'junk', fixable: true, message: 'domain is on the capture blocklist' }];
    }
    if (JUNK_DOMAIN_PATTERNS.some(re => re.test(skill.domain))) {
      const allBeacon = skill.endpoints.every(isBeaconShaped); // vacuously true for []
      if (allBeacon) {
        return [{
          ...base, severity: 'junk', fixable: true,
          message: 'junk-pattern domain, no non-beacon endpoints',
        }];
      }
      return [{
        ...base, severity: 'warn', fixable: false,
        message: 'junk-pattern domain but carries real data endpoints — review manually',
      }];
    }
    return [];
  },
  fix(): FixPlan {
    return { action: 'quarantine' };
  },
};
