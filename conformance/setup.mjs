import { prepareReferences } from './references.mjs';
import { prepareNativePathFinder } from './native.mjs';

prepareReferences(['engine', 'common', 'driver', 'storage'], ['engine', 'common', 'storage']);
prepareNativePathFinder();
