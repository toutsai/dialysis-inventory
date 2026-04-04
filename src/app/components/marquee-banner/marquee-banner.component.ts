import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FirebaseService } from '@services/firebase.service';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';

@Component({
  selector: 'app-marquee-banner',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './marquee-banner.component.html',
  styleUrl: './marquee-banner.component.css'
})
export class MarqueeBannerComponent implements OnInit, OnDestroy {
  private readonly firebase = inject(FirebaseService);
  private unsubscribe: (() => void) | null = null;

  marqueeContent = '';

  ngOnInit(): void {
    const q = query(
      collection(this.firebase.db, 'marquee_settings'),
      orderBy('updatedAt', 'desc'),
      limit(1)
    );

    this.unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const data = snapshot.docs[0].data();
        this.marqueeContent = data['content'] || '';
      }
    });
  }

  ngOnDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }
}
