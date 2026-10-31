/** A database-maintained projection, not a second source of inventory truth.
 * Every Inventory has id, so imports/deletions/new writers need no dual write.
 * No images, provider payloads, notes, customer details or custom fields.
 */
export {COMPACT_SEARCH_INDEX, COMPACT_SEARCH_FIELDS, supportsCompactSearch} from '../../amplify/compactSearchIndex';
