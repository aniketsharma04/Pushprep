import { type Flag } from '../flags/flags.helpers';
import type { ParsedConfigActivity } from '../parse-argv.types';
export declare function collectConfigAccess(task: string | null, flags: Flag[], positionals: string[]): ParsedConfigActivity;
