import { prepareReferences } from './references.ts';
import { prepareNativePathFinder } from './native.ts';

prepareReferences(['engine', 'common', 'driver', 'storage'], ['engine', 'common', 'storage']);
prepareNativePathFinder();
