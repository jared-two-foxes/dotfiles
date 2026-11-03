import { executeAndReview } from '../pi/agent/extensions/conductor/adapter.mjs';
import { contract } from './helpers/conductor-contract.mjs';
contract('Pi', executeAndReview);
