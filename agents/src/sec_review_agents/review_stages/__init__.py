"""Reusable review stages, bounded feedback loop, and single-agent core.

The package exposes reusable stage components for analysis, mitigation,
verification, and CVSS scoring. It also owns the mitigation/verification
feedback loop used by workflows that need bounded verifier-driven retries, plus
the reusable core for single-agent fix strategies.
"""
