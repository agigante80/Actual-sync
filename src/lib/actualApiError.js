/**
 * Enhances errors thrown by @actual-app/api with human-readable context
 * and troubleshooting guidance.
 *
 * @param {Error} error - The original error from the API
 * @param {{ phase: string, serverUrl: string, syncId: string, isEncrypted: boolean }} context
 * @param {{ warn: Function, debug: Function }} logger
 * @returns {Error} Enhanced error with .originalError, .phase, .code, .errorCode
 */
function enhanceActualApiError(error, context, logger) {
    const { phase, serverUrl, syncId, isEncrypted } = context;

    // The Actual API throws PostError but by the time we catch it, it's often a plain Error with no message
    let originalError = error?.message || error?.toString() || '';

    // Check for empty or generic error - common with PostError that loses its details
    if (!originalError || originalError === 'Error' || originalError.trim() === '') {
        if (phase === 'download' && isEncrypted) {
            originalError = 'network-failure during encryption key validation';
            logger.warn('Empty error caught for encrypted budget download - likely encryption key issue');
        } else if (phase === 'download') {
            originalError = 'budget download failed';
            logger.warn('Empty error caught for budget download');
        } else {
            originalError = 'sync operation failed';
            logger.warn('Empty error caught during sync phase');
        }
    }

    // Check if this is a PostError with a reason field
    if (error?.type === 'PostError' && error?.reason) {
        originalError = error.reason;
        logger.debug('PostError detected with reason', { reason: error.reason });
    }

    // Check the string representation for PostError pattern
    const errorString = error?.toString() || '';
    if (errorString.includes('PostError: PostError: ')) {
        const match = errorString.match(/PostError: PostError: (.+)/);
        if (match && match[1]) {
            originalError = match[1].trim();
        }
    }

    // Check stack trace for PostError pattern
    if (error?.stack && error.stack.includes('PostError: PostError: ')) {
        const stackMatch = error.stack.match(/PostError: PostError: (.+)/);
        if (stackMatch && stackMatch[1]) {
            originalError = stackMatch[1].split('\n')[0].trim();
        }
    }

    // Build contextual troubleshooting guidance
    const errorDetails = [];

    if (phase === 'download') {
        if (originalError.includes('Could not get remote files')) {
            errorDetails.push('Failed to retrieve budget files from server.');
            errorDetails.push(`Verify that Sync ID "${syncId}" exists on server "${serverUrl}".`);
            errorDetails.push('Check that file sync is enabled in your Actual Budget server settings.');
            if (!isEncrypted) {
                errorDetails.push('If this budget uses encryption, provide the encryptionPassword in config.');
            }
        } else if (originalError.includes('network-failure')) {
            if (isEncrypted) {
                errorDetails.push('Network connection to Actual Budget server failed during encryption key validation.');
                errorDetails.push(`Check that server is accessible at: ${serverUrl}`);
                errorDetails.push('Verify the encryptionPassword is correct for this encrypted budget.');
                errorDetails.push('Ensure the Actual Budget server supports encrypted budgets.');
            } else {
                errorDetails.push('Network connection to Actual Budget server failed.');
                errorDetails.push(`Check that server is accessible at: ${serverUrl}`);
                errorDetails.push('Verify the server password is correct.');
            }
        } else if (originalError.includes('decrypt-failure') || originalError.includes('Invalid password')) {
            errorDetails.push('Failed to decrypt budget file.');
            errorDetails.push('Verify the encryptionPassword is correct for this budget.');
        } else if (originalError.includes('unauthorized')) {
            errorDetails.push('Authentication failed.');
            errorDetails.push('Verify the server password is correct.');
        }
    } else if (phase === 'sync') {
        if (originalError.includes('network-failure')) {
            errorDetails.push('Network connection lost during file synchronization.');
            errorDetails.push(`Check server connectivity at: ${serverUrl}`);
            errorDetails.push('This may be a transient network issue - sync will retry on next schedule.');
        } else if (originalError.includes('sync-error')) {
            errorDetails.push('File synchronization conflict detected.');
            errorDetails.push('This may occur if budget was modified on server during sync.');
            errorDetails.push('Retry will automatically resolve most conflicts.');
        }
    }

    // Create enhanced error message
    const enhancedMessage = errorDetails.length > 0
        ? `${originalError}\n\nTroubleshooting:\n- ${errorDetails.join('\n- ')}`
        : originalError;

    const enhancedError = new Error(enhancedMessage);
    enhancedError.originalError = error;
    enhancedError.phase = phase;
    enhancedError.code = error?.code;
    enhancedError.errorCode = error?.errorCode;

    return enhancedError;
}

module.exports = { enhanceActualApiError };
