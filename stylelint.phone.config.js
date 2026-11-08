// Temporary, for the phone token pass: the repo's rules with the phone CSS not ignored. Delete it, and the phone files
// from ignoreFiles in stylelint.config.js, once the phone CSS passes.  bunx stylelint --config stylelint.phone.config.js <file>
import base from './stylelint.config.js';

export default { ...base, ignoreFiles: [] };
