PRAGMA foreign_keys = ON;

ALTER TABLE articles ADD COLUMN published_revision_id INTEGER REFERENCES article_revisions(id) ON DELETE RESTRICT;
ALTER TABLE articles ADD COLUMN public_state TEXT CHECK (public_state IN ('published', 'withdrawn'));

UPDATE articles
SET published_revision_id = current_revision_id,
    public_state = state
WHERE state IN ('published', 'withdrawn');

CREATE INDEX articles_public_state_idx ON articles(public_state);
