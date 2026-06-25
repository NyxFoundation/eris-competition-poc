#!/usr/bin/env bash
# =============================================================================
# eris spot runner — EC2 user-data（最小・watchdog のみ）
# =============================================================================
# SSH モデルでは実作業を laptop が remote-run.sh で駆動するため、user-data は
# 「コスト安全網」だけ持つ。@@WATCHDOG_MIN@@ 分後に必ず terminate（shutdown）し、
# laptop が落ちて回収・terminate に来なくても放置課金しない。
# run-spot.sh が @@WATCHDOG_MIN@@ を埋めて渡す。
# =============================================================================
shutdown -h +@@WATCHDOG_MIN@@
