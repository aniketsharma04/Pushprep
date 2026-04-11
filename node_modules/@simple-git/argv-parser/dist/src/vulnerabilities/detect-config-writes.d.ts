import type { ParsedConfigActivity } from '../parse-argv.types';
import type { Vulnerability } from './vulnerability.types';
export declare function detectConfigWrites({ write }: ParsedConfigActivity): Generator<Vulnerability>;
