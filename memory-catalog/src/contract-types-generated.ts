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
    "/v1/observation-backlog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Summarize observations that have not yet been consumed by a memory revision. */
        get: operations["getObservationBacklog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/maintenance-input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Return a bounded observation set and the active memory state it must be maintained against. */
        get: operations["getMaintenanceInput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory-tree/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description List immutable memory tree revisions in descending revision order. */
        get: operations["listMemoryTreeRevisions"];
        put?: never;
        /** @description Create an immutable memory tree revision with compare-and-swap and consume its source observations. */
        post: operations["createMemoryTreeRevision"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory-tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Return the current memory tree revision and its artifact reference, if one exists. */
        get: operations["getMemoryTree"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/memory-tree/revisions/{revision}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Return one immutable memory tree revision and its maintenance transcript. */
        get: operations["getMemoryTreeRevision"];
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
        MaintenanceId: string;
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
        ObservationBacklog: {
            pending_count: number;
            /** Format: date-time */
            oldest_pending_created_at: string | null;
        };
        MaintenanceObservation: {
            extraction_id: components["schemas"]["ExtractionId"];
            body_markdown: string;
        };
        MaintenanceInput: {
            base_revision: number;
            active_memory_tree_reference: components["schemas"]["ArtifactReference"] | null;
            observations: components["schemas"]["MaintenanceObservation"][];
        };
        MaintenanceInputResult: {
            input: components["schemas"]["MaintenanceInput"] | null;
        };
        MemoryTreeRevisionCreation: {
            maintenance_id: components["schemas"]["MaintenanceId"];
            base_revision: number;
            extraction_ids: components["schemas"]["ExtractionId"][];
            memory_tree_reference: components["schemas"]["ArtifactReference"];
            maintenance_transcript_reference: components["schemas"]["ArtifactReference"];
        };
        MemoryTreeRevisionCreationResult: {
            created: boolean;
            revision: number;
            maintenance_id: components["schemas"]["MaintenanceId"];
        };
        MemoryTree: {
            revision: number;
            memory_tree_reference: components["schemas"]["ArtifactReference"] | null;
        };
        MemoryTreeRevision: {
            revision: number;
            maintenance_id: components["schemas"]["MaintenanceId"];
            base_revision: number;
            extraction_ids: components["schemas"]["ExtractionId"][];
            memory_tree_reference: components["schemas"]["ArtifactReference"];
            maintenance_transcript_reference: components["schemas"]["ArtifactReference"];
            /** Format: date-time */
            created_at: string;
        };
        MemoryTreeRevisionList: {
            revisions: components["schemas"]["MemoryTreeRevision"][];
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
        /** @description An immutable identity differs from existing content, or a revision compare-and-swap precondition failed. */
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
    getObservationBacklog: {
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
                    "application/json": components["schemas"]["ObservationBacklog"];
                };
            };
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    getMaintenanceInput: {
        parameters: {
            query: {
                limit: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current memory state and bounded pending observations, or null when none are pending. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceInputResult"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    listMemoryTreeRevisions: {
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
            /** @description One page of immutable memory tree revision history. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryTreeRevisionList"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    createMemoryTreeRevision: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemoryTreeRevisionCreation"];
            };
        };
        responses: {
            /** @description An identical maintenance submission had already created this revision. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryTreeRevisionCreationResult"];
                };
            };
            /** @description The revision was created. */
            201: {
                headers: {
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryTreeRevisionCreationResult"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
        };
    };
    getMemoryTree: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current memory tree revision and artifact reference. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryTree"];
                };
            };
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    getMemoryTreeRevision: {
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
            /** @description The requested immutable memory tree revision. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryTreeRevision"];
                };
            };
            400: components["responses"]["InvalidBody"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
}
