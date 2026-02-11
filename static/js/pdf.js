'use strict';

import { convertPdfToMp4 } from './pdfWasmConverter.js';

// 進捗表示要素
const progressText = document.createElement('div');
progressText.id = 'progress-text';
progressText.className = 'text-center mt-2';
progressText.style.display = 'none';

/**
 * 進捗を更新
 * @param {string} message - 進捗メッセージ
 */
function updateProgress(message) {
    progressText.textContent = message;
    progressText.style.display = 'block';
    console.log(message);
}

/**
 * MP4をサーバーにアップロードしてURLを取得
 * @param {Blob} mp4Blob - MP4動画のBlob
 * @returns {Promise<Object>} アップロード結果
 */
async function uploadMp4(mp4Blob) {
    const formData = new FormData();
    formData.append('file', mp4Blob, 'converted.mp4');

    const response = await fetch('/api/save-movie/', {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
    }

    return response.json();
}

/**
 * PDF変換処理（WASMベース）
 * @returns {Promise<Object>} レスポンスオブジェクト風のオブジェクト
 */
async function fetchMovieUrl() {
    const fileInput = document.getElementById('files');
    const file = fileInput.files?.[0];

    if (!file) {
        throw new Error('No file selected');
    }

    const frameSec = parseInt(document.querySelector('input[name="frame_sec"]:checked').value);

    // WASMでPDF -> MP4変換
    const mp4Blob = await convertPdfToMp4(file, frameSec, updateProgress);

    // サーバーにアップロード
    updateProgress('Uploading video...');
    const result = await uploadMp4(mp4Blob);

    return {
        ok: true,
        json: async () => result
    };
}

/**
 * イベントリスナーを設定
 */
function addEventListeners() {
    // 進捗テキスト要素を追加
    const progressBar = document.getElementById('progress_bar');
    if (progressBar?.parentNode) {
        progressBar.parentNode.after(progressText);
    }

    submitButton.addEventListener('click', submit);
}

// baseFunctions.js の fetchMovieUrl を上書き
window.fetchMovieUrl = fetchMovieUrl;

addEventListeners();
