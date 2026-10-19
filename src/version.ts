// Single source of the version string: package.json.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
