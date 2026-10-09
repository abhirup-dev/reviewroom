#!/usr/bin/env bash
# Creates a small Go/proto/SQL repo with a 2-commit feature branch to try readingroom on.
#   bash examples/make-demo-repo.sh /tmp/demoapp-demo
set -euo pipefail
DIR="${1:-/tmp/demoapp-demo}"
rm -rf "$DIR" && mkdir -p "$DIR" && cd "$DIR"
git init -q -b main && git config user.email dev@example.com && git config user.name sam
mkdir -p migrations
cat > migrations/003_ledger_keys.sql <<'RR_EOF'
CREATE TABLE ledger_keys (
  key        TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
RR_EOF
mkdir -p pkg/ranker
cat > pkg/ranker/errors.go <<'RR_EOF'
package ranker

import "errors"

var ErrMissingUser = errors.New("ranker: feed request has no user id")
RR_EOF
mkdir -p pkg/ranker
cat > pkg/ranker/request_builder.go <<'RR_EOF'
package ranker

import (
	"context"

	"github.com/example/demoapp/pkg/ledger"
	pb "github.com/example/demoapp/proto/feed/v2"
)

// Builder assembles the request the ranker scores candidates with.
type Builder struct {
	ledger *ledger.Client
}

// Deps are injected by the service wiring in cmd/demoapp.
type Deps struct {
	Ledger *ledger.Client
}

func NewBuilder(deps Deps) *Builder {
	return &Builder{
		ledger: deps.Ledger,
	}
}

var baseKeys = []string{"user_lang", "user_city", "affinity_v3", "watch_time_7d"}

// Build fetches the user's base features and wraps them for the ranker.
func (b *Builder) Build(ctx context.Context, req *pb.FeedRequest) (*pb.RankerRequest, error) {
	if req.GetUserId() == "" {
		return nil, ErrMissingUser
	}
	feats, err := b.ledger.Fetch(ctx, req.GetUserId(), baseKeys)
	if err != nil {
		return nil, err
	}
	rr := &pb.RankerRequest{UserId: req.GetUserId(), Features: feats}
	return rr, nil
}
RR_EOF
mkdir -p pkg/ledger
cat > pkg/ledger/client.go <<'RR_EOF'
package ledger

import (
	"context"

	pb "github.com/example/demoapp/proto/feed/v2"
)

// Client reads online features from Ledger.
type Client struct{ addr string }

func New(addr string) *Client { return &Client{addr: addr} }

// Fetch returns the requested feature keys for one user.
func (c *Client) Fetch(ctx context.Context, userID string, keys []string) (map[string]*pb.Feature, error) {
	out := make(map[string]*pb.Feature, len(keys))
	for _, k := range keys {
		out[k] = &pb.Feature{Name: k}
	}
	return out, nil
}
RR_EOF
mkdir -p proto/feed/v2
cat > proto/feed/v2/ranker_request.proto <<'RR_EOF'
syntax = "proto3";

package feed.v2;

message Feature {
  string name = 1;
  bytes value = 2;
}

message FeedRequest {
  string user_id = 1;
  int32 limit = 2;
}

message RankerRequest {
  string user_id = 1;
  map<string, Feature> features = 2;
}
RR_EOF
git add -A && git commit -qm 'demoapp: base ranker request builder'
git checkout -qb feat/activity-events
mkdir -p migrations
cat > migrations/004_activity_events.sql <<'RR_EOF'
CREATE TABLE activity_events (
  user_id TEXT        NOT NULL,
  ts      TIMESTAMPTZ NOT NULL,
  event   TEXT        NOT NULL,
  post_id TEXT
);

CREATE INDEX activity_events_user_ts ON activity_events (user_id, ts DESC);
RR_EOF
mkdir -p pkg/features/habit
cat > pkg/features/habit/fetcher.go <<'RR_EOF'
package habit

import (
	"context"
	"fmt"
	"time"

	tfsv2 "github.com/example/ledger-feature-service-sdk/v2"
	pb "github.com/example/demoapp/proto/feed/v2"
)

// Fetcher reads a user's recent ACTIVITY events from TFS v2.
type Fetcher struct {
	tfs *tfsv2.Client
}

func NewFetcher(c *tfsv2.Client) *Fetcher { return &Fetcher{tfs: c} }

// RecentEvents returns the user's ACTIVITY events inside window w, newest first.
func (f *Fetcher) RecentEvents(ctx context.Context, uid string, w time.Duration) ([]*pb.ActivityEvent, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	res, err := f.tfs.BatchGet(ctx, habitKeys(uid, w))
	if err != nil {
		return nil, fmt.Errorf("habit: batch get: %w", err)
	}
	return decode(res), nil
}

func habitKeys(uid string, w time.Duration) []tfsv2.Key {
	buckets := int(w / time.Hour)
	keys := make([]tfsv2.Key, 0, buckets)
	for i := 0; i < buckets; i++ {
		keys = append(keys, tfsv2.Key{Entity: uid, Feature: "activity_events", Bucket: i})
	}
	return keys
}

func decode(res *tfsv2.BatchResult) []*pb.ActivityEvent {
	out := make([]*pb.ActivityEvent, 0, len(res.Rows))
	for _, r := range res.Rows {
		out = append(out, &pb.ActivityEvent{Event: r.String("event"), PostId: r.String("post_id"), TsMs: r.Int64("ts")})
		if len(out) == 50 {
			break
		}
	}
	return out
}
RR_EOF
mkdir -p pkg/features/habit
cat > pkg/features/habit/fetcher_test.go <<'RR_EOF'
package habit

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRecentEvents_Timeout(t *testing.T) {
	f := newFetcher(stubTFS{delay: 50 * time.Millisecond})
	_, err := f.RecentEvents(context.Background(), "u1", 7*24*time.Hour)
	require.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestRecentEvents_CapsAt50(t *testing.T) {
	f := newFetcher(stubTFS{rows: 80})
	got, err := f.RecentEvents(context.Background(), "u1", 24*time.Hour)
	require.NoError(t, err)
	require.Len(t, got, 50)
}
RR_EOF
mkdir -p proto/feed/v2
cat > proto/feed/v2/ranker_request.proto <<'RR_EOF'
syntax = "proto3";

package feed.v2;

message Feature {
  string name = 1;
  bytes value = 2;
}

message FeedRequest {
  string user_id = 1;
  int32 limit = 2;
}

message ActivityEvent {
  string event = 1;
  string post_id = 2;
  int64 ts_ms = 3;
}

message RankerRequest {
  string user_id = 1;
  map<string, Feature> features = 2;
  // Recent ACTIVITY events, newest first, at most 50. Empty when the fetch degrades.
  repeated ActivityEvent activity_events = 12;
}
RR_EOF
git add -A && git commit -qm 'habit: TFS v2 fetcher, ActivityEvent proto, activity_events table'
mkdir -p pkg/ranker
cat > pkg/ranker/request_builder.go <<'RR_EOF'
package ranker

import (
	"context"
	"time"

	"github.com/example/demoapp/pkg/features/habit"
	"github.com/example/demoapp/pkg/log"
	"github.com/example/demoapp/pkg/metrics"
	"github.com/example/demoapp/pkg/ledger"
	pb "github.com/example/demoapp/proto/feed/v2"
)

// Builder assembles the request the ranker scores candidates with.
type Builder struct {
	ledger  *ledger.Client
	habit   *habit.Fetcher
	metrics *metrics.Registry
}

// Deps are injected by the service wiring in cmd/demoapp.
type Deps struct {
	Ledger  *ledger.Client
	Habit   *habit.Fetcher
	Metrics *metrics.Registry
}

func NewBuilder(deps Deps) *Builder {
	return &Builder{
		ledger:  deps.Ledger,
		habit:   deps.Habit,
		metrics: deps.Metrics,
	}
}

var baseKeys = []string{"user_lang", "user_city", "affinity_v3", "watch_time_7d"}

// habitWindow is how far back recent ACTIVITY events are read.
const habitWindow = 7 * 24 * time.Hour

// Build fetches the user's base features and wraps them for the ranker.
func (b *Builder) Build(ctx context.Context, req *pb.FeedRequest) (*pb.RankerRequest, error) {
	if req.GetUserId() == "" {
		return nil, ErrMissingUser
	}
	feats, err := b.ledger.Fetch(ctx, req.GetUserId(), baseKeys)
	if err != nil {
		return nil, err
	}
	activityEvents, err := b.habit.RecentEvents(ctx, req.GetUserId(), habitWindow)
	if err != nil {
		log.Warn(ctx, "habit fetch failed, degrading", log.Err(err))
		activityEvents = nil
	}
	rr := &pb.RankerRequest{
		UserId:      req.GetUserId(),
		Features:    feats,
		ActivityEvents: activityEvents,
	}
	return rr, nil
}
RR_EOF
git add -A && git commit -qm 'ranker: attach recent ACTIVITY events to RankerRequest'
echo "demo repo ready: $DIR (branch feat/activity-events)"
