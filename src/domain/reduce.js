// 聚合归约：把只追加事件流折叠为当前状态。投影与命令不变量共用同一套折叠规则，
// 任何状态都必须能由事件日志重建。

function emptyState() {
  return {
    carriers: new Map(),
    agreements: new Map(),
    custodies: new Map(),
    batches: new Map(),
    files: new Map(),
    persons: new Map(),
    segments: new Map(),
    transcripts: new Map(),
    notes: new Map(),
    songs: new Map(),
    decisions: new Map(),
  };
}

function applyEvent(state, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "CARRIER_ACCESSIONED": {
      state.carriers.set(e.aggregate_id, {
        carrier_id: e.aggregate_id,
        title: p.title,
        tape_no: p.tape_no ?? null,
        media_type: p.media_type ?? null,
        duration_ms: p.duration_ms ?? null,
        recorded_on: p.recorded_on ?? null,
        // 原始库位属受限信息：仅折叠保存，输出层负责遮蔽
        original_location: p.original_location ?? null,
        agreement_ids: [],
        accession_event: e.event_id,
      });
      break;
    }
    case "CARRIER_AGREEMENT_LINKED": {
      const c = state.carriers.get(e.aggregate_id);
      if (c && !c.agreement_ids.includes(p.agreement_id)) c.agreement_ids.push(p.agreement_id);
      break;
    }
    case "DONATION_AGREEMENT_RECORDED":
      state.agreements.set(e.aggregate_id, {
        agreement_id: e.aggregate_id,
        agreement_no: p.agreement_no ?? null,
        donor: p.donor ?? null,
        signed_on: p.signed_on ?? null,
        scope_carrier_id: p.scope_carrier_id ?? null,
        scope_segment_ids: [...(p.scope_segment_ids ?? [])],
        restrictions: [...(p.restrictions ?? [])],
      });
      break;
    case "CUSTODY_RECORD_FILED": {
      const list = state.custodies.get(p.carrier_id) ?? [];
      list.push({
        record_id: e.aggregate_id,
        carrier_id: p.carrier_id,
        location_code: p.location_code ?? null,
        transferred_from: p.transferred_from ?? null,
        received_on: p.received_on ?? null,
        condition: p.condition ?? null,
        handler: p.handler ?? null,
      });
      state.custodies.set(p.carrier_id, list);
      break;
    }
    case "DIGITIZATION_BATCH_RECORDED":
      state.batches.set(e.aggregate_id, {
        batch_id: e.aggregate_id,
        batch_no: p.batch_no ?? null,
        digitized_on: p.digitized_on ?? null,
        operator: p.operator ?? null,
        equipment: p.equipment ?? null,
        file_ids: [...(p.file_ids ?? [])],
      });
      break;
    case "DIGITIZATION_VERIFIED":
      state.files.set(p.file_id, {
        file_id: p.file_id,
        role: "original_capture",
        carrier_id: p.carrier_id,
        batch_id: p.batch_id ?? null,
        codec: p.codec ?? null,
        sample_rate: p.sample_rate ?? null,
        channels: p.channels ?? null,
        byte_size: p.byte_size ?? null,
        checksums: [...(p.checksums ?? [])],
        source_file_id: null,
        kind: null,
        process: null,
        verified_event: e.event_id,
      });
      break;
    case "DERIVATIVE_RECORDED":
      state.files.set(e.aggregate_id, {
        file_id: e.aggregate_id,
        role: "derived",
        source_file_id: p.source_file_id,
        kind: p.kind ?? "processed",
        process: p.process ?? null,
        carrier_id: p.carrier_id ?? null,
        codec: p.codec ?? null,
        byte_size: p.byte_size ?? null,
        checksums: [...(p.checksums ?? [])],
        batch_id: null,
        created_event: e.event_id,
      });
      break;
    case "PERSON_REGISTERED":
      state.persons.set(e.aggregate_id, {
        person_id: e.aggregate_id,
        display_name: p.display_name,
        aliases: [],
        visibility: p.visibility ?? "public",
        note: p.note ?? null,
        roles: [...(p.roles ?? [])],
      });
      break;
    case "PERSON_ALIAS_NOTED": {
      const person = state.persons.get(e.aggregate_id);
      if (person) {
        person.aliases.push({
          alias: p.alias,
          period: p.period ?? null,
          note: p.note ?? null,
          event_id: e.event_id,
        });
      }
      break;
    }
    case "SEGMENT_CUT":
      state.segments.set(e.aggregate_id, {
        segment_id: e.aggregate_id,
        carrier_id: p.carrier_id,
        source_file_id: p.source_file_id,
        time_range: { ...p.time_range },
        channel: p.channel ?? "mixed",
        topics: [...(p.topics ?? [])],
        people_mentioned: [...(p.people_mentioned ?? [])],
        song_ids: [...(p.song_ids ?? [])],
        speaker_candidates: [],
        confirmed_speaker: null,
        withdrawals: [],
        cut_event: e.event_id,
      });
      break;
    case "SPEAKERS_PROPOSED": {
      const seg = state.segments.get(e.aggregate_id);
      if (!seg) break;
      for (const c of p.candidates ?? []) {
        if (p.action === "withdraw") {
          const found = seg.speaker_candidates.find((x) => x.candidate_id === c.candidate_id);
          if (found) {
            found.status = "withdrawn";
            found.withdrawn_event = e.event_id;
            // 撤回的是现行结论：片段回到"无定案"状态，身份保持待考
            if (seg.confirmed_speaker?.candidate_id === c.candidate_id) {
              seg.confirmed_speaker = null;
            }
          }
        } else {
          seg.speaker_candidates.push({
            candidate_id: c.candidate_id,
            person_id: c.person_id ?? null,
            proposed_name: c.proposed_name ?? null,
            basis: c.basis ?? null,
            confidence: c.confidence ?? null,
            note: c.note ?? null,
            disputed: Boolean(c.disputed),
            proposed_by: e.actor?.id ?? p.proposed_by ?? null,
            status: "proposed",
            added_event: e.event_id,
          });
        }
      }
      break;
    }
    case "SPEAKER_CONFIRMED": {
      const seg = state.segments.get(e.aggregate_id);
      if (!seg) break;
      const cand = seg.speaker_candidates.find((x) => x.candidate_id === p.candidate_id);
      if (cand) {
        // 新确认推翻旧确认：旧候选保留可追溯，但不再是现行结论
        for (const other of seg.speaker_candidates) {
          if (other.candidate_id !== cand.candidate_id && other.status === "confirmed") {
            other.status = "superseded";
            other.superseded_by = e.event_id;
          }
        }
        cand.status = "confirmed";
        cand.confirmed_event = e.event_id;
        const previous = seg.confirmed_speaker;
        seg.confirmed_speaker = {
          candidate_id: p.candidate_id,
          person_id: p.person_id ?? cand.person_id,
          evidence: [...(p.evidence ?? [])],
          confirmed_by: e.actor?.id ?? null,
          note: p.note ?? null,
          event_id: e.event_id,
        };
        if (previous) seg.confirmed_speaker.supersedes = previous.event_id;
      }
      break;
    }
    case "TRANSCRIPT_DRAFTED":
    case "TRANSCRIPT_REVISED": {
      const t =
        state.transcripts.get(e.aggregate_id) ??
        { segment_id: p.segment_id, current_version: 0, versions: [] };
      t.versions.push({
        version: e.version,
        event_id: e.event_id,
        text: p.text,
        at: e.occurred_at,
        editor: e.actor?.id ?? p.editor ?? null,
        change_summary: p.change_summary ?? null,
        corrections: [...(p.corrections ?? [])],
        based_on_version: p.based_on_version ?? null,
      });
      t.current_version = e.version;
      state.transcripts.set(e.aggregate_id, t);
      break;
    }
    case "REVIEW_NOTE_ADDED":
      state.notes.set(e.aggregate_id, {
        note_id: e.aggregate_id,
        segment_id: p.segment_id,
        category: p.category ?? "general",
        author: e.actor?.id ?? p.author ?? null,
        note: p.note,
        transcript_version: p.transcript_version ?? null,
        at: e.occurred_at,
        resolution: p.resolution ?? null,
      });
      break;
    case "SONG_RIGHTS_ASSESSED": {
      const s = state.songs.get(e.aggregate_id) ?? { song_id: e.aggregate_id, versions: [] };
      s.versions.push({
        version: e.version,
        title: p.title,
        work_status: p.work_status,
        license: p.license ?? null,
        rights_holders_note: p.rights_holders_note ?? null,
        segment_ids: [...(p.segment_ids ?? [])],
        basis: p.basis ?? null,
        at: e.occurred_at,
        event_id: e.event_id,
      });
      s.current = s.versions[s.versions.length - 1];
      state.songs.set(e.aggregate_id, s);
      break;
    }
    case "RELEASE_APPROVED":
    case "RELEASE_DECISION_AMENDED": {
      const d =
        state.decisions.get(e.aggregate_id) ??
        { segment_id: p.segment_id, current_version: 0, versions: [] };
      d.versions.push({
        version: e.version,
        event_id: e.event_id,
        disposition: p.disposition,
        bases: [...(p.bases ?? [])],
        masking: p.masking ?? null,
        decided_by: e.actor?.id ?? null,
        at: e.occurred_at,
        rationale: p.rationale ?? null,
        review_after: p.review_after ?? null,
      });
      d.current_version = e.version;
      state.decisions.set(e.aggregate_id, d);
      break;
    }
    case "SEGMENT_WITHDRAWN": {
      const seg = state.segments.get(e.aggregate_id);
      if (seg) {
        seg.withdrawals.push({
          event_id: e.event_id,
          reason: p.reason,
          basis_refs: [...(p.basis_refs ?? [])],
          at: e.occurred_at,
          expected_restore_after: p.expected_restore_after ?? null,
          restored_event: null,
          restored_at: null,
        });
      }
      break;
    }
    case "SEGMENT_RESTORED": {
      const seg = state.segments.get(e.aggregate_id);
      if (seg && seg.withdrawals.length > 0) {
        const last = seg.withdrawals[seg.withdrawals.length - 1];
        last.restored_event = e.event_id;
        last.restored_at = e.occurred_at;
      }
      break;
    }
    default:
      break;
  }
  return state;
}

export function reduceAll(events) {
  const state = emptyState();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) applyEvent(state, e);
  return state;
}

export { emptyState, applyEvent };
