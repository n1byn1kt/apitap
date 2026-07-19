// src/doctor/checks/beacon-endpoints.ts
import { isBlocklisted } from '../../capture/blocklist.js';
import type { SkillEndpoint, SkillFile } from '../../types.js';
import type { Check, EndpointKey, Finding, FixPlan } from '../types.js';

const TRACKER_SEGMENTS = new Set(['capi', 'collect', 'pixel', 'beacon', 'track']);

function hasTrackerSegment(path: string): boolean {
  return path.split('?')[0].split('/').some(seg => TRACKER_SEGMENTS.has(seg.toLowerCase()));
}

function targetsBlocklistedHost(ep: SkillEndpoint): boolean {
  try {
    return isBlocklisted(new URL(ep.examples.request.url).hostname);
  } catch {
    return false;
  }
}

/**
 * Offline beacon classifier. SkillEndpoint stores no response status, so
 * "204/1x1" detection is impossible — we require BOTH a tracker signal
 * (path segment or blocklisted example host) AND a contentless response
 * (no responseSchema, and zero bytes or an empty shape). Skeletons are
 * intentionally body-less and exempt.
 */
export function isBeaconShaped(ep: SkillEndpoint): boolean {
  if (ep.endpointProvenance === 'skeleton') return false;
  if (ep.responseSchema) return false;
  const tracker = hasTrackerSegment(ep.path) || targetsBlocklistedHost(ep);
  if (!tracker) return false;
  const emptyShape = !ep.responseShape?.fields || ep.responseShape.fields.length === 0;
  return ep.responseBytes === 0 || emptyShape;
}

const epKey = (ep: SkillEndpoint): EndpointKey => ({ method: ep.method, path: ep.path });

export const beaconEndpoints: Check = {
  id: 'beacon-endpoints',
  title: 'Tracker/beacon endpoints',
  scan(skill: SkillFile): Finding[] {
    const beacons = skill.endpoints.filter(isBeaconShaped);
    const suspects = skill.endpoints.filter(
      ep => !isBeaconShaped(ep) && (hasTrackerSegment(ep.path) || targetsBlocklistedHost(ep)),
    );
    const findings: Finding[] = [];
    if (beacons.length > 0) {
      findings.push({
        checkId: 'beacon-endpoints', domain: skill.domain, severity: 'junk', fixable: true,
        message: `${beacons.length} tracker endpoint(s): ${beacons.map(e => e.path).join(', ')}`,
        endpointKeys: beacons.map(epKey),
      });
    }
    if (suspects.length > 0) {
      findings.push({
        checkId: 'beacon-endpoints', domain: skill.domain, severity: 'warn', fixable: false,
        message: `${suspects.length} tracker-like path(s) with real responses (not stripped): ${suspects.map(e => e.path).join(', ')}`,
        endpointKeys: suspects.map(epKey),
      });
    }
    return findings;
  },
  fix(skill: SkillFile): FixPlan {
    const kept = skill.endpoints.filter(ep => !isBeaconShaped(ep));
    if (kept.length === 0) return { action: 'quarantine' };
    return { action: 'edit', skill: { ...skill, endpoints: kept } };
  },
};
