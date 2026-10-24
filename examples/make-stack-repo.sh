#!/usr/bin/env bash
# Creates a small repo with a stack of three branches to try stacked reviews on:
#   main <- stack-1 (2 commits) <- stack-2 (2 commits) <- stack-3 (1 commit)
# --squashed: stack-1 was then squash-merged into main (as GitHub does), so merge-base(main, stack-2)..stack-2
# drags in stack-1's two commits while stack-2's own layer, stack-1..stack-2, has two.
#   bash examples/make-stack-repo.sh /tmp/rr-stack [--squashed]
set -euo pipefail
DIR="${1:-/tmp/rr-stack}"
rm -rf "$DIR" && mkdir -p "$DIR" && cd "$DIR"
git init -q -b main && git config user.email dev@example.com && git config user.name stacker
commit() { git add -A && git commit -qm "$1"; }

mkdir -p store
cat > store/store.go <<'RR_EOF'
package store

// Store keeps values by key.
type Store struct {
	m map[string]string
}

func New() *Store { return &Store{m: map[string]string{}} }

func (s *Store) Get(k string) string { return s.m[k] }
RR_EOF
commit 'store: a map behind Get'

git checkout -qb stack-1
cat >> store/store.go <<'RR_EOF'

func (s *Store) Put(k, v string) { s.m[k] = v }
RR_EOF
commit 'store: Put'
cat >> store/store.go <<'RR_EOF'

func (s *Store) Delete(k string) { delete(s.m, k) }
RR_EOF
commit 'store: Delete'

git checkout -qb stack-2
mkdir -p cache
cat > cache/cache.go <<'RR_EOF'
package cache

import "example.com/stack/store"

// Cache reads through to a Store.
type Cache struct {
	s    *store.Store
	seen map[string]string
}
RR_EOF
commit 'cache: a read-through cache'
cat >> cache/cache.go <<'RR_EOF'

func (c *Cache) Get(k string) string {
	if v, ok := c.seen[k]; ok {
		return v
	}
	v := c.s.Get(k)
	c.seen[k] = v
	return v
}
RR_EOF
commit 'cache: Get remembers'

git checkout -qb stack-3
sed -i.bak 's/^func (s \*Store) Get(k string) string { return s.m\[k\] }$/func (s *Store) Get(k string) string {\n\treturn s.m[k] \/\/ missing keys read as ""\n}/' store/store.go && rm store/store.go.bak
cat >> cache/cache.go <<'RR_EOF'

func (c *Cache) Forget(k string) { delete(c.seen, k) }
RR_EOF
commit 'cache: Forget; store: say what a missing key reads as'

if [[ "${2:-}" == --squashed ]]; then
  git checkout -q main && git merge -q --squash stack-1 >/dev/null && git commit -qm 'store: Put and Delete (#1)'
fi
git checkout -q stack-3
