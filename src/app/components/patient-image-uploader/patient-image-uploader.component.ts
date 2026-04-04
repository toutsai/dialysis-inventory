import { Component, Input, Output, EventEmitter, inject, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FirebaseService } from '@services/firebase.service';
import { httpsCallable } from 'firebase/functions';

@Component({
  selector: 'app-patient-image-uploader',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './patient-image-uploader.component.html',
  styleUrl: './patient-image-uploader.component.css'
})
export class PatientImageUploaderComponent {
  private readonly firebase = inject(FirebaseService);

  @Input() patientId = '';
  @Input() patientName = '';
  @Input() existingImageUrl = '';
  @Output() imageUpdated = new EventEmitter<string>();

  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasElement') canvasElement!: ElementRef<HTMLCanvasElement>;

  isCameraActive = false;
  isUploading = false;
  capturedImage: string | null = null;
  errorMessage: string | null = null;
  private stream: MediaStream | null = null;

  get currentState(): string {
    if (this.isUploading) return 'uploading';
    if (this.capturedImage) return 'captured';
    if (this.isCameraActive) return 'streaming';
    return 'idle';
  }

  async startCamera(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      if (this.videoElement) {
        this.videoElement.nativeElement.srcObject = this.stream;
      }
      this.isCameraActive = true;
    } catch (err) {
      console.error('無法啟動相機:', err);
      alert('無法啟動相機，請確認已授權使用相機。');
    }
  }

  capturePhoto(): void {
    if (!this.videoElement || !this.canvasElement) return;
    const video = this.videoElement.nativeElement;
    const canvas = this.canvasElement.nativeElement;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0);
      this.capturedImage = canvas.toDataURL('image/jpeg', 0.8);
    }
    this.stopCamera();
  }

  stopCamera(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.isCameraActive = false;
  }

  async uploadImage(): Promise<void> {
    if (!this.capturedImage || !this.patientId) return;
    this.isUploading = true;
    try {
      const uploadFn = httpsCallable(this.firebase.functions, 'uploadPatientImage');
      const result = await uploadFn({
        patientId: this.patientId,
        imageData: this.capturedImage,
      });
      const data = result.data as any;
      if (data.imageUrl) {
        this.imageUpdated.emit(data.imageUrl);
        this.capturedImage = null;
      }
    } catch (err) {
      console.error('上傳失敗:', err);
      alert('圖片上傳失敗，請稍後再試。');
    } finally {
      this.isUploading = false;
    }
  }

  clearCapture(): void {
    this.capturedImage = null;
  }

  captureImage(): void {
    this.capturePhoto();
  }

  retakePhoto(): void {
    this.capturedImage = null;
    this.startCamera();
  }

  async uploadToDrive(): Promise<void> {
    await this.uploadImage();
  }
}
