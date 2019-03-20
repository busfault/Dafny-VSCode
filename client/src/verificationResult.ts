"use strict";

export enum VerificationStatus {
    Verified = 0,
    NotVerified = 1,
    Failed = 2,
}

export interface VerificationResult {
    verificationStatus: VerificationStatus;
    proofObligations: number;
    errorCount: number;
    crashed: boolean;
    counterModel: any;
}
