// Generated from contracts/memory-catalog-api/openapi.yaml. Do not edit.
export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Report whether the Memory Catalog process is serving requests. */
        get: operations["health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/extractions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Register one completed extraction and its optional observation, or replay identical content. */
        post: operations["registerExtraction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/extractions/{extraction_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Return one completed extraction, its transcript reference, and its optional observation. */
        get: operations["getExtraction"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/observations/pending-summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Summarize observations that have not yet been consumed by a memory revision. */
        get: operations["pendingObservationSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/maintenance/batches/select": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Select a bounded observation batch against the current memory revision. */
        post: operations["selectMaintenanceBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/maintenance/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Atomically publish a memory tree revision and consume its source observations. */
        post: operations["completeMaintenance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/active-revision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Return the active revision and its memory tree artifact reference, if one exists. */
        get: operations["activeRevision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description List immutable memory revisions in descending revision order. */
        get: operations["listRevisions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/revisions/{revision}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Return one immutable memory revision and its maintenance transcript. */
        get: operations["getRevision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ArtifactReference: {
            uri: string;
            digest: string;
            media_type: string;
            size_bytes: number;
        };
        ExtractionId: string;
        ExtractionObservation: {
            body_markdown: string;
        };
        ExtractionRegistration: {
            extraction_id: components["schemas"]["ExtractionId"];
            source_workflow: string;
            source_run_id: string;
            source_review_unit_id: string;
            diagnostic_bundle_digest: string;
            transcript_reference: components["schemas"]["ArtifactReference"];
            observation: components["schemas"]["ExtractionObservation"] | null;
        };
        ExtractionRegistrationResult: {
            /** @constant */
            ok: true;
            created: boolean;
        };
        ExtractionRecord: {
            extraction_id: components["schemas"]["ExtractionId"];
            source_workflow: string;
            source_run_id: string;
            source_review_unit_id: string;
            diagnostic_bundle_digest: string;
            transcript_reference: components["schemas"]["ArtifactReference"];
            observation: components["schemas"]["ExtractionObservation"] | null;
            /** Format: date-time */
            created_at: string;
        };
        PendingObservationSummary: {
            pending_count: number;
            /** Format: date-time */
            oldest_pending_created_at: string | null;
        };
        MaintenanceBatchSelection: {
            limit: number;
        };
        MaintenanceObservation: {
            extraction_id: components["schemas"]["ExtractionId"];
            body_markdown: string;
        };
        MaintenanceBatch: {
            base_revision: number;
            active_memory_tree_reference: components["schemas"]["ArtifactReference"] | null;
            observations: components["schemas"]["MaintenanceObservation"][];
        };
        MaintenanceBatchResult: {
            batch: components["schemas"]["MaintenanceBatch"] | null;
        };
        MaintenanceCompletion: {
            base_revision: number;
            extraction_ids: components["schemas"]["ExtractionId"][];
            memory_tree_reference: components["schemas"]["ArtifactReference"];
            maintenance_transcript_reference: components["schemas"]["ArtifactReference"];
        };
        MaintenanceCompletionResult: {
            completed: boolean;
        };
        ActiveRevision: {
            revision: number;
            memory_tree_reference: components["schemas"]["ArtifactReference"] | null;
        };
        MemoryRevision: {
            revision: number;
            memory_tree_reference: components["schemas"]["ArtifactReference"];
            maintenance_transcript_reference: components["schemas"]["ArtifactReference"];
            /** Format: date-time */
            created_at: string;
        };
        MemoryRevisionList: {
            revisions: components["schemas"]["MemoryRevision"][];
            next_before_revision: number | null;
        };
        Health: {
            /** @constant */
            status: "ok";
        };
        ErrorResponse: {
            error: string;
            /** @enum {string} */
            code?: "INVALID_BODY" | "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "INTERNAL_ERROR";
        };
    };
    responses: {
        /** @description The JSON body does not match the operation schema. */
        InvalidBody: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Missing or invalid catalog bearer token. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The extraction identity already exists with different content. */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The requested catalog record does not exist. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Opaque internal server error. */
        InternalError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description The request body exceeds the service limit. */
        PayloadTooLarge: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Service is running. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
            500: components["responses"]["InternalError"];
        };
    };
    registerExtraction: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtractionRegistration"];
            };
        };
        responses: {
            /** @description Extraction accepted or identically replayed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtractionRegistrationResult"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
        };
    };
    getExtraction: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                extraction_id: components["schemas"]["ExtractionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The requested extraction. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtractionRecord"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    pendingObservationSummary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pending observation count and age. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PendingObservationSummary"];
                };
            };
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    selectMaintenanceBatch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceBatchSelection"];
            };
        };
        responses: {
            /** @description Current revision and one pending observation batch. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceBatchResult"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
        };
    };
    completeMaintenance: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceCompletion"];
            };
        };
        responses: {
            /** @description Whether the revision CAS and observation consumption committed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceCompletionResult"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
        };
    };
    activeRevision: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current active revision and memory tree artifact reference. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActiveRevision"];
                };
            };
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    listRevisions: {
        parameters: {
            query?: {
                before_revision?: string;
                limit?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of immutable memory revision history. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryRevisionList"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    getRevision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                revision: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The requested immutable memory revision. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryRevision"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
}
