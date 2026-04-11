import type { Flag } from '../flags/flags.helpers';
import type { ParsedConfigActivity } from '../parse-argv.types';
import type { ParsedVulnerabilities } from './vulnerability.types';
export declare function vulnerabilityAnalysis(task: null | string, flags: Flag[], config: ParsedConfigActivity): ParsedVulnerabilities;
