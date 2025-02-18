import { declare } from "@babel/helper-plugin-utils";

import pipeline from "@babel/plugin-proposal-pipeline-operator";
import functionBind from "@babel/plugin-proposal-function-bind";
import optionalChaining from "@babel/plugin-proposal-optional-chaining";
import nullishCoalesce from "@babel/plugin-proposal-nullish-coalescing-operator";
import doExpr from "@babel/plugin-proposal-do-expressions";

import guard from "@xjs/plugin-transform-guard";
import accessAsFunction from "@xjs/plugin-transform-access-as-function";
import declarationExistential from "@xjs/plugin-transform-declaration-existential";
import existence from "@xjs/plugin-transform-existence";
import arrow from "@xjs/plugin-transform-arrow";
import underscore from "@xjs/plugin-transform-underscore-parameters";
import comprehension from "@xjs/plugin-transform-comprehension";

export default declare(
  (api) => {
    api.assertVersion(7);

    return { overrides: [{ plugins: [
      // extant es proposal plugins:
      [ pipeline, { proposal: "fsharp" } ],
      [ functionBind ],
      [ optionalChaining, { loose: true } ],
      [ nullishCoalesce, { loose: true } ],
      [ doExpr ],

      // xjs plugins:
      [ guard ],
      [ accessAsFunction ],
      [ declarationExistential ],
      [ existence ],
      [ arrow ],
      [ underscore ],
      [ comprehension ],
    ] }] };
  },
);
