import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
console.log("resolved:", require.resolve("pptxgenjs"));
import def from "pptxgenjs";
import * as ns from "pptxgenjs";
console.log("default typeof:", typeof def, def && Object.getOwnPropertyNames(def).slice(0, 8));
