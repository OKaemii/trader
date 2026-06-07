import type { Collection, Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import {
    parseLinks,
    type ResearchLink,
    type ResearchLinkKind,
    type ResearchNote,
} from '../application/ResearchNotes.ts';

// Persisted shape of a research_notes doc (Task 5 #58 contract). `_id` is the entity key the note is
// ABOUT (a ticker today; the store stays kind-agnostic so a strategy/signal note could reuse it).
interface ResearchNoteDoc {
    _id: string;
    body: string;
    links: ResearchLink[];
    updatedBy: string | null;
    updatedAt: number;
}

// Mongo store for the research notebook (Task 33 §G). Owns the GET/PUT/DELETE of a per-entity note
// and the backlink lookup ("notes referencing entity X"). The single backlink index — a multikey
// index over (links.kind, links.ref) — is created lazily on first write (createIndex is idempotent;
// the once-flag just skips the redundant call). Index intent was documented by Task 5 (#58).
export class MongoResearchNotesStore {
    private readonly coll: Collection<ResearchNoteDoc>;
    private indexesEnsured = false;

    constructor(db: Db) {
        this.coll = db.collection<ResearchNoteDoc>(COLLECTIONS.RESEARCH_NOTES);
    }

    /** Read one note by its entity key. Returns null when no note exists (the route maps that to an
     *  empty-but-200 payload so the editor can render a fresh page). */
    async get(ticker: string): Promise<ResearchNote | null> {
        const doc = await this.coll.findOne({ _id: ticker });
        if (!doc) return null;
        return toNote(doc);
    }

    /**
     * Upsert a note: parse the body's `@`-links and persist body + links + provenance. Returns the
     * saved note (with the freshly-parsed links + the stamped updatedAt) so the route can echo the
     * authoritative state back without a second read.
     */
    async put(ticker: string, body: string, updatedBy: string | null): Promise<ResearchNote> {
        await this.ensureIndexes();
        const links = parseLinks(body);
        const updatedAt = Date.now();
        await this.coll.updateOne(
            { _id: ticker },
            { $set: { body, links, updatedBy, updatedAt } },
            { upsert: true },
        );
        return { ticker, body, links, updatedBy, updatedAt };
    }

    /** Delete a note. Returns true when a doc was removed (used by the QA cleanup + UI delete). */
    async delete(ticker: string): Promise<boolean> {
        const res = await this.coll.deleteOne({ _id: ticker });
        return res.deletedCount > 0;
    }

    /**
     * Backlink index: every note whose body links the given entity. A multikey match on the
     * embedded `links` array — `{ links: { $elemMatch: { kind, ref } } }` — hits the
     * (links.kind, links.ref) index. Returned newest-first so the most recent referrer leads.
     */
    async backlinks(kind: ResearchLinkKind, ref: string): Promise<ResearchNote[]> {
        const docs = await this.coll
            .find({ links: { $elemMatch: { kind, ref } } })
            .sort({ updatedAt: -1 })
            .toArray();
        return docs.map(toNote);
    }

    private async ensureIndexes(): Promise<void> {
        if (this.indexesEnsured) return;
        // Multikey index over the embedded links — powers the backlink lookup. Mongo indexes each
        // array element, so a note with N links contributes N index entries keyed (kind, ref).
        await this.coll.createIndex({ 'links.kind': 1, 'links.ref': 1 }, { name: 'research_notes_backlink' });
        this.indexesEnsured = true;
    }
}

/** Map a persisted doc to the served note shape (`_id` → `ticker`). */
function toNote(doc: ResearchNoteDoc): ResearchNote {
    return {
        ticker: doc._id,
        body: doc.body,
        links: Array.isArray(doc.links) ? doc.links : [],
        updatedBy: doc.updatedBy ?? null,
        updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : null,
    };
}
